import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadConfig, mapFrame } from '../src/events.mjs';
import { dispatch, ingest, writerClient } from '../src/runtime.mjs';
import { Store } from '../src/store.mjs';

const NOW = 1794096000;
const ROOM = '101';
const OTHER = '102';
const MEMBER = '9007199254740993';
const OPTIONS = { profileRef: 'open-profile-test', verificationRef: 'synthetic-verification' };
const ROOMS = {
  [ROOM]: { ...OPTIONS, templates: { rejoin: '다시 환영합니다, {name}!' } },
  [OTHER]: OPTIONS,
};
const config = loadConfig(JSON.stringify({ liveEnabled: true, rooms: ROOMS }));

function frame(origin, seq, { room = ROOM, event = String(seq), name = '가나다',
  members, feedType, at = NOW } = {}) {
  const member = { userId: MEMBER, nickName: name };
  const defaultFeed = {
    NEWMEM: { feedType: 4, members: members ?? [member] },
    DELMEM: { feedType: 2, member },
    KICKMEM: { feedType: 6, member },
  }[origin];
  return JSON.stringify({
    json: { chat_id: room, _id: String(seq), id: event, type: 0, created_at: at,
      v: JSON.stringify({ origin }) },
    msg: JSON.stringify({ ...defaultFeed, feedType: feedType ?? defaultFeed?.feedType })
      .replaceAll(`"${MEMBER}"`, MEMBER),
  });
}

function fixture(t, live = false) {
  const dir = mkdtempSync(join(tmpdir(), 'openchat-test-'));
  const file = join(dir, 'new.sqlite');
  let store = new Store(file, config.rooms, { live });
  const extra = [];
  t.after(() => {
    for (const connection of extra) connection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    file,
    open() {
      const connection = new Store(file, config.rooms, { live });
      extra.push(connection);
      return connection;
    },
    reopen() {
      store.close();
      store = new Store(file, config.rooms, { live });
    },
    apply(origin, seq, options) {
      return store.apply(mapFrame(frame(origin, seq, options), store.rooms));
    },
  };
}

test('four transitions, precise member ID, room templates, and persisted dedup', t => {
  const f = fixture(t);
  f.apply('NEWMEM', 10);
  f.apply('DELMEM', 11);
  f.apply('NEWMEM', 12, { name: '$& {name}' });
  f.apply('KICKMEM', 13);
  f.apply('NEWMEM', 10, { room: OTHER });
  f.reopen();
  assert.equal(f.apply('KICKMEM', 13), 'duplicate');
  const rows = f.store.db.prepare('SELECT member, transition FROM history WHERE room=? ORDER BY rowid').all(ROOM);
  assert.deepEqual(rows.map(row => [row.member, row.transition]),
    ['join', 'leave', 'rejoin', 'kick'].map(kind => [MEMBER, kind]));
  assert.equal(f.store.db.prepare('SELECT body FROM outbox WHERE room=? AND event=?').get(ROOM, '12').body,
    '다시 환영합니다, $& {name}!');
  assert.equal(f.store.status().outbox[0].count, 5);
});

test('unapproved room and ordinary message are ignored; inconsistent member feeds are rejected', t => {
  const f = fixture(t);
  assert.equal(f.apply('NEWMEM', 1, { room: '999', feedType: 99 }), 'ignored');
  assert.equal(f.apply('MSG', 1), 'ignored');
  assert.throws(() => f.apply('NEWMEM', 1, { feedType: 2 }), /invalid-feed-type/);
  assert.throws(() => f.apply('NEWMEM', 1, { members: [{ userId: MEMBER }, { userId: MEMBER }] }), /duplicate-subject/);
  assert.deepEqual(f.store.status().history, []);
});

test('duplicate membership state and reordered multi-member replay generate no extra notices', t => {
  const f = fixture(t);
  const a = { userId: MEMBER, nickName: 'A' };
  const b = { userId: '9007199254740994', nickName: 'B' };
  f.apply('NEWMEM', 1, { members: [a, b] });
  assert.equal(f.apply('NEWMEM', 1, { members: [b, a] }), 'duplicate');
  assert.throws(() => f.apply('NEWMEM', 1, { members: [b] }), /event-conflict/);
  f.apply('NEWMEM', 2, { members: [b, a] });
  assert.equal(f.store.status().outbox[0].count, 2);
});

test('failed multi-member transaction leaves no partial history, queue, or checkpoint', t => {
  const f = fixture(t);
  f.store.db.exec(`CREATE TRIGGER inject_fault BEFORE INSERT ON history WHEN NEW.member='9007199254740994'
    BEGIN SELECT RAISE(ABORT, 'test-fault'); END;`);
  const members = [{ userId: MEMBER }, { userId: '9007199254740994' }];
  assert.throws(() => f.apply('NEWMEM', 1, { members }), /test-fault/);
  assert.deepEqual(f.store.status().cursors, []);
  assert.deepEqual(f.store.status().history, []);
  assert.deepEqual(f.store.status().outbox, []);
  f.store.db.exec('DROP TRIGGER inject_fault;');
  assert.equal(f.apply('NEWMEM', 1, { members }), 'applied');
});

test('late event stops ingestion; backfill repairs history and drops obsolete pending notices', async t => {
  const f = fixture(t, true);
  f.apply('NEWMEM', 10);
  f.apply('NEWMEM', 12);
  const stream = () => Readable.from([Buffer.from(frame('DELMEM', 11))]);
  await assert.rejects(ingest(f.store, stream()), /sequence-conflict-or-late/);
  f.reopen();
  assert.equal(f.store.halted, true);
  await ingest(f.store, stream(), { backfill: true });
  assert.equal(f.store.db.prepare("SELECT transition FROM history WHERE event='12'").get().transition, 'rejoin');
  assert.equal(f.store.status().cursors[0].sequence, '12');
  assert.equal(f.store.status().outbox[0].state, 'discarded');
  f.store.resume();
  assert.equal(f.apply('KICKMEM', 13), 'applied');
});

test('STOP, expiry, and accepted receipt prevent unintended or repeated delivery', async t => {
  const f = fixture(t, true);
  f.apply('NEWMEM', 1, { at: NOW - 120 });
  f.apply('DELMEM', 2);
  const sent = [];
  const send = async payload => { sent.push(payload); return 'test-receipt'; };
  assert.deepEqual(await dispatch(f.store, send, () => true, () => NOW), { accepted: 0 });
  let checks = 0;
  assert.deepEqual(await dispatch(f.store, send, () => ++checks === 2, () => NOW), { accepted: 0 });
  assert.deepEqual(await dispatch(f.store, send, () => false, () => NOW), { accepted: 1 });
  assert.equal(sent[0].profileRef, OPTIONS.profileRef);
  assert.equal(sent[0].roomId, ROOM);
  assert.match(sent[0].key, /^haedalkong-v1:/);
  assert.equal(sent[0].expiresAt, NOW + 120);
  f.reopen();
  assert.deepEqual(await dispatch(f.store, send, () => false, () => NOW), { accepted: 0 });
  assert.equal(sent.length, 1);
});

test('shared SQLite claim serializes dispatch and a lost receipt requires explicit resolution', async t => {
  const f = fixture(t, true);
  const second = f.open();
  f.apply('NEWMEM', 1);
  f.apply('DELMEM', 2);
  await assert.rejects(dispatch(f.store, async () => {
    assert.throws(() => second.claim(NOW), /dispatch-halted/);
    throw Error('timeout');
  }, () => false, () => NOW), /writer-unconfirmed/);
  f.reopen();
  const [record] = f.store.unresolved();
  assert.equal(record.state, 'uncertain');
  assert.throws(() => f.store.resume(), /unresolved-delivery/);
  f.store.resolve(record.key, 'accepted');
  f.store.resume();
  const sent = [];
  await dispatch(f.store, async payload => { sent.push(payload); return 'receipt'; }, () => false, () => NOW);
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0].key, record.key);
});

test('crash after claim survives restart without resubmission', t => {
  const f = fixture(t, true);
  f.apply('NEWMEM', 1);
  const claim = f.store.claim(NOW);
  f.reopen();
  assert.equal(f.store.unresolved()[0].key, claim.key);
  assert.throws(() => f.store.claim(NOW), /dispatch-halted/);
});

test('live config and store reject missing proof, changed profile, and unrelated databases', t => {
  assert.throws(() => loadConfig('{"liveEnabled":true,"rooms":{"101":{}}}'), /unverified-binding/);
  const f = fixture(t, true);
  const different = loadConfig(JSON.stringify({
    liveEnabled: true, rooms: { [ROOM]: { ...OPTIONS, profileRef: 'wrong-profile' } },
  }));
  assert.throws(() => new Store(f.file, different.rooms, { live: true }), /binding-changed/);
  assert.throws(() => new Store(f.file, config.rooms), /database-identity/);
  const other = join(f.file, '..', 'unrelated.sqlite');
  const existing = new DatabaseSync(other);
  existing.exec('CREATE TABLE untouched (n INTEGER); INSERT INTO untouched VALUES (1);');
  existing.close();
  assert.throws(() => new Store(other, config.rooms), /database-identity/);
  const check = new DatabaseSync(other, { readOnly: true });
  assert.equal(check.prepare('SELECT n FROM untouched').get().n, 1);
  check.close();
});

test('writer client requires loopback, bearer auth, no redirects, and matching receipt', async () => {
  const token = 't'.repeat(32);
  const payload = { key: 'key', roomId: ROOM, profileRef: OPTIONS.profileRef };
  assert.throws(() => writerClient('http://example.com:9800', token), /invalid-writer-config/);
  assert.throws(() => writerClient('http://127.0.0.1:9800/reply', token), /invalid-writer-config/);
  const send = writerClient('http://127.0.0.1:9800', token, async (url, request) => {
    assert.equal(url.pathname, '/v1/haedalkong/enqueue');
    assert.equal(request.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.redirect, 'error');
    assert.deepEqual(JSON.parse(request.body), payload);
    return Response.json({ status: 'accepted', ...payload, receipt: 'r1' }, { status: 202 });
  });
  assert.equal(await send(payload), 'r1');
  const mismatch = writerClient('http://127.0.0.1:9800', token, async () =>
    Response.json({ status: 'accepted', ...payload, roomId: OTHER, receipt: 'r1' }, { status: 202 }));
  await assert.rejects(mismatch(payload), /writer-unconfirmed/);
});
