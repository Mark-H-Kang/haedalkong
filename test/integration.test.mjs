import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Gateway, gatewayServer } from '../src/gateway.mjs';
import { Relay, irisReader } from '../src/relay.mjs';
import { Store } from '../src/store.mjs';

const roomId = '200';
const mainRoom = '100';
const profileRef = 'test-profile';
const verificationRef = 'test-proof';
const rooms = new Map([[roomId, { profileRef, verificationRef, templates: {} }]]);
const inbound = 'a'.repeat(43);
const iris = 'b'.repeat(43);
const old = 'c'.repeat(43);
const header = token => `Bearer ${token}`;

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'haedalkong-integration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('loopback enqueue isolates room and tokens, and callback atomically rechecks the STOP and claims', async t => {
  const now = 1794096000;
  const input = { key: 'haedalkong-v1:200:11:12', roomId, profileRef, verificationRef, text: '합성',
    expiresAt: now + 60 };
  let paused = false;
  let sent = 0;
  const gateway = new Gateway(join(workspace(t), 'writer.sqlite'), {
    mainRoom, rooms, token: inbound, irisToken: iris, clock: () => now, permitted: () => !paused,
    send: async payload => {
      assert.equal(gateway.authorizeSend(header(inbound), payload), 401);
      paused = true;
      assert.equal(gateway.authorizeSend(header(iris), payload), 403);
      paused = false;
      assert.equal(gateway.authorizeSend(header(iris), { ...payload, verificationRef: 'wrong' }), 403);
      assert.equal(gateway.authorizeSend(header(iris), payload), 204);
      assert.equal(gateway.authorizeSend(header(iris), payload), 409);
      sent++;
    },
  });
  const server = gatewayServer(gateway);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const submit = (token, payload) => fetch(`http://127.0.0.1:${server.address().port}/v1/haedalkong/enqueue`, {
      method: 'POST', headers: { Authorization: header(token) }, body: JSON.stringify(payload),
    });
    assert.equal((await submit(old, input)).status, 401);
    assert.equal((await submit(iris, input)).status, 401);
    assert.equal((await submit(inbound, { ...input, roomId: mainRoom })).status, 403);
    assert.equal((await submit(inbound, { ...input, expiresAt: now })).status, 403);
    paused = true;
    assert.equal((await submit(inbound, input)).status, 503);
    paused = false;
    const accepted = await submit(inbound, input);
    assert.equal(accepted.status, 202);
    const receipt = await accepted.json();
    assert.deepEqual(await (await submit(inbound, input)).json(), receipt);
    assert.equal((await submit(inbound, { ...input, text: '변조' })).status, 409);
    assert.equal(await gateway.sendNext(), true);
    assert.equal(await gateway.sendNext(), false);
    assert.equal(sent, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    gateway.db.close();
  }
});

test('an ambiguous Iris dispatch holds the durable queue across reopen and does not retry', async t => {
  const file = join(workspace(t), 'writer.sqlite');
  const now = 1794096000;
  const input = { key: 'haedalkong-v1:200:11:12', roomId, profileRef, verificationRef, text: '합성',
    expiresAt: now + 60 };
  let attempts = 0;
  const options = { mainRoom, rooms, token: inbound, irisToken: iris, clock: () => now,
    permitted: () => true, send: async () => { attempts++; throw Error('timeout'); } };
  let gateway = new Gateway(file, options);
  try {
    assert.equal(gateway.accept(header(inbound), input).status, 202);
    assert.equal(await gateway.sendNext(), false);
    gateway.db.close();
    gateway = new Gateway(file, options);
    assert.equal(gateway.accept(header(inbound), { ...input, key: 'haedalkong-v1:200:13:12' }).status, 503);
    assert.equal(await gateway.sendNext(), false);
    assert.equal(attempts, 1);
    assert.equal(gateway.db.prepare("SELECT count(*) AS n FROM outbox WHERE state='uncertain'").get().n, 1);
    gateway.db.prepare("UPDATE outbox SET state='isolated-uncertain' WHERE key=?").run(input.key);
    assert.equal(gateway.accept(header(inbound), input).status, 409);
    assert.equal(gateway.authorizeSend(header(iris), input), 409);
    assert.equal(await gateway.sendNext(), false);
    assert.equal(attempts, 1);
    assert.equal(gateway.accept(header(inbound), { ...input, key: 'haedalkong-v1:200:13:12' }).status, 202);
  } finally { gateway.db.close(); }
});

test('Gateway sends beyond both old quotas while keeping a single claim and discarding expired work', async t => {
  let now = 1794096000;
  let sent = 0;
  const gateway = new Gateway(join(workspace(t), 'writer.sqlite'), {
    mainRoom, rooms, token: inbound, irisToken: iris, clock: () => now, permitted: () => true,
    send: async payload => {
      assert.equal(await gateway.sendNext(), false);
      assert.equal(gateway.authorizeSend(header(iris), payload), 204);
      sent++;
    },
  });
  try {
    const payload = event => ({ key: `haedalkong-v1:200:${event}:12`, roomId, profileRef,
      verificationRef, text: '합성', expiresAt: now + 110 });
    for (let event = 1; event <= 14; event++) {
      assert.equal(gateway.accept(header(inbound), payload(event)).status, 202);
    }
    for (let i = 0; i < 13; i++) assert.equal(await gateway.sendNext(), true);
    now += 110;
    assert.equal(await gateway.sendNext(), false);
    assert.equal(sent, 13);
    assert.equal(gateway.db.prepare("SELECT state FROM outbox WHERE key='haedalkong-v1:200:14:12'").get().state, 'expired');
  } finally { gateway.db.close(); }
});

test('Iris reads only the requested room and includes sender ID needed for decryption', async () => {
  const read = irisReader(3000, async (url, opts) => {
    assert.equal(url, 'http://127.0.0.1:3000/query');
    const { query, bind } = JSON.parse(opts.body);
    assert.match(query, /user_id/u);
    assert.match(query, /WHERE chat_id = \? AND _id >= CAST\(\? AS INTEGER\)/u);
    assert.deepEqual(bind, [roomId, '9007199254740993']);
    return new Response('{"data":[{"chat_id":200,"_id":9007199254740993}]}');
  });
  assert.deepEqual(await read(roomId, '9007199254740993'), [{ chat_id: roomId, _id: '9007199254740993' }]);
});

test('relay retains a lossless anchor, quietly reconciles a reconnect and rejects an altered anchor', async t => {
  const file = join(workspace(t), 'relay.sqlite');
  const r = (seq, origin = 'MSG') => {
    const member = { userId: '9007199254740993', nickName: '합성' };
    const body = origin === 'NEWMEM' ? { feedType: 4, members: [member] } : { feedType: 2, member };
    return { chat_id: roomId, _id: String(seq), id: String(seq), created_at: '1794096000',
      type: origin === 'MSG' ? '1' : '0', v: JSON.stringify({ origin }), message: JSON.stringify(body) };
  };
  const first = r(1);
  const joined = r(2, 'NEWMEM');
  const leave = r(3, 'DELMEM');
  let store = new Store(file, rooms);
  try {
    let relay = new Relay(store);
    assert.equal(await relay.scan(async () => [first]), 0);
    assert.equal(await relay.scan(async () => [first, joined]), 1);
    assert.equal(store.status().outbox.length, 0);
    store.close();
    store = new Store(file, rooms);
    relay = new Relay(store);
    await assert.rejects(relay.scan(async () => [{ ...joined, id: '9' }, leave]), /relay-anchor-changed/);
    assert.equal(relay.cursor().position, '2');
    assert.equal(await relay.scan(async () => [joined, leave]), 1);
    const record = store.db.prepare('SELECT member, joins, exits FROM members').get();
    assert.deepEqual({ ...record }, { member: '9007199254740993', joins: 1, exits: 1 });
    assert.equal(store.status().outbox.length, 0);
  } finally { store.close(); }
});
