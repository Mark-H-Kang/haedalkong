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

function fixture(t, live = false, rooms = config.rooms) {
  const dir = mkdtempSync(join(tmpdir(), 'openchat-test-'));
  const file = join(dir, 'new.sqlite');
  let store = new Store(file, rooms, { live });
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
      const connection = new Store(file, rooms, { live });
      extra.push(connection);
      return connection;
    },
    reopen() {
      store.close();
      store = new Store(file, rooms, { live });
    },
    apply(origin, seq, options) {
      return store.apply(mapFrame(frame(origin, seq, options), store.rooms));
    },
    body(event, room = ROOM) {
      return store.db.prepare('SELECT body FROM outbox WHERE room = ? AND event = ?').get(room, String(event))?.body;
    },
    member(room = ROOM) {
      return store.db.prepare('SELECT * FROM members WHERE room = ? AND member = ?').get(room, MEMBER);
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
  assert.match(f.body(12), /^💕 재입장\n다시 환영합니다, \$& \{name\}!\n/u);
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
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM nicknames').get().n, 0);
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
  assert.equal(f.member().joins, 2);
  assert.equal(f.member().exits, 1);
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
  assert.equal(sent[0].expiresAt, NOW + 110);
  assert.ok(sent[0].expiresAt - (NOW - 5) <= 120, 'Iris accepts the expiry with a five-second slower Android clock');
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

const defaults = loadConfig(JSON.stringify({ liveEnabled: false, rooms: { [ROOM]: {}, [OTHER]: {} } })).rooms;
const at = value => Date.parse(value) / 1000;
const first = at('2026-11-08T13:20:00+09:00');
const exit = at('2026-11-08T15:30:00+09:00');
const again = at('2026-11-08T16:00:00+09:00');

test('first observed join prints Seoul time and sets first/last timestamp and count', t => {
  const f = fixture(t, false, defaults);
  f.apply('NEWMEM', 1, { name: '홍길동', at: first });
  assert.equal(f.body(1), '🚪 최초 입장\n🦦 홍길동님이 입장하셨어요!\n\n입장 시각: 26년 11월 8일 13시 20분');
  assert.equal(f.member().first_join, first);
  assert.equal(f.member().last_join, first);
  assert.equal(f.member().last_exit, null);
  assert.equal(f.member().joins, 1);
  assert.equal(f.member().inside, 1);
  assert.deepEqual(f.store.recentNicknames(ROOM, MEMBER), ['홍길동']);
});

test('voluntary leave and kick have byte-identical public text and separate internal kinds', t => {
  const normal = fixture(t, false, defaults);
  const forced = fixture(t, false, defaults);
  for (const f of [normal, forced]) f.apply('NEWMEM', 1, { name: '홍길동', at: first });
  normal.apply('DELMEM', 2, { name: '홍길동', at: exit });
  forced.apply('KICKMEM', 2, { name: '홍길동', at: exit });
  assert.equal(normal.body(2), '🚪 퇴장 감지\n🦦 홍길동님이 퇴장하셨어요!\n\n' +
    '퇴장 시각: 26년 11월 8일 15시 30분 (1회)\n\n입장 시각: 26년 11월 8일 13시 20분 (1회)');
  assert.equal(forced.body(2), normal.body(2));
  assert.equal(normal.member().leaves, 1);
  assert.equal(forced.member().kicks, 1);
  assert.equal(forced.member().exits, 1);
  assert.equal(forced.store.db.prepare("SELECT kind FROM frames WHERE event = '2'").get().kind, 'kick');
  assert.equal(forced.member().inside, 0);
});

test('legacy kick template cannot override the shared exit greeting', t => {
  const rooms = loadConfig(JSON.stringify({ liveEnabled: false, rooms: { [ROOM]: { templates: {
    leave: '잘 가요, {name}!', kick: '강제 퇴장: {name}',
  } } } })).rooms;
  const f = fixture(t, false, rooms);
  f.apply('KICKMEM', 1);
  assert.match(f.body(1), /^🚪 퇴장 감지\n잘 가요, 가나다!/u);
  assert.doesNotMatch(f.body(1), /강제|강퇴/u);
});

test('missing prior join stays unknown and a distinct frame with the same state adds no count or notice', t => {
  const f = fixture(t, false, defaults);
  f.apply('DELMEM', 1, { name: null, at: exit });
  f.apply('KICKMEM', 2, { name: '콩', at: exit + 10 });
  assert.match(f.body(1), /입장 시각: 기록 없음$/u);
  assert.equal(f.body(2), undefined);
  assert.equal(f.member().last_join, null);
  assert.equal(f.member().last_exit, exit);
  assert.equal(f.member().joins, 0);
  assert.equal(f.member().exits, 1);
  assert.equal(f.member().kicks, 0);
  f.apply('NEWMEM', 3, { name: '콩', at: again });
  assert.match(f.body(3), /^🚪 최초 입장/u);
  assert.equal(f.member().joins, 1);
});

test('rejoin after both exit kinds keeps the first time and accumulates once across restart', t => {
  const f = fixture(t, false, defaults);
  const dates = [first, first + 60, first + 120, first + 180, first + 240, exit, again];
  const origins = ['NEWMEM', 'DELMEM', 'NEWMEM', 'KICKMEM', 'NEWMEM', 'KICKMEM', 'NEWMEM'];
  for (const [i, origin] of origins.entries()) f.apply(origin, i + 1, { at: dates[i] });
  f.reopen();
  assert.equal(f.apply('NEWMEM', 7, { at: again }), 'duplicate');
  f.apply('NEWMEM', 8, { at: again + 60 });
  assert.equal(f.body(8), undefined);
  assert.equal(f.member().first_join, first);
  assert.equal(f.member().last_join, again);
  assert.equal(f.member().last_exit, exit);
  assert.deepEqual([f.member().joins, f.member().exits, f.member().leaves, f.member().kicks], [4, 3, 1, 2]);
  assert.equal(f.body(7), '💕 재입장\n🦦 가나다님 다시 오셨네요!\n\n' +
    '최초 입장 시각: 26년 11월 8일 13시 20분\n입장 시각: 26년 11월 8일 16시 00분 (4회)\n\n' +
    '퇴장 시각: 26년 11월 8일 15시 30분 (3회)');
});

test('nickname history grows from one through five, then displays the latest five including reused names', t => {
  const f = fixture(t, false, defaults);
  const names = ['콩콩이', '바다콩', '수달이', '홍길동', '해달이', '콩콩이'];
  f.apply('NEWMEM', 1, { name: names[0], at: first });
  assert.deepEqual(f.store.recentNicknames(ROOM, MEMBER), names.slice(0, 1));
  assert.doesNotMatch(f.body(1), /닉변 감지/u);
  for (const [index, name] of names.entries()) {
    if (index === 0) continue;
    const event = index * 2 + 1;
    f.apply('DELMEM', event - 1, { name: names[index - 1], at: exit });
    f.apply('NEWMEM', event, { name, at: again });
    const recent = names.slice(Math.max(0, index - 4), index + 1);
    assert.ok(f.body(event).endsWith(
      `🦦 닉변 감지! 🦦\n✏️ 이전 닉네임: ${names[index - 1]}\n✨ 변경 닉네임: ${name}\n\n` +
      `📋 최근 닉네임 이력 (${recent.length}개)\n${recent.join(' → ')}`));
  }
  f.reopen();
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM nicknames').get().n, 6);
  assert.equal(f.member().name, '콩콩이');
  assert.equal(f.member().joins, 6);
});

test('nickname changes from verified membership frames only, isolated by room and ID', t => {
  const f = fixture(t, false, defaults);
  f.apply('NEWMEM', 1, { name: '홍길동' });
  f.apply('NEWMEM', 1, { room: OTHER, name: '타방이름' });
  f.apply('NEWMEM', 2, { members: [{ userId: '321', nickName: '홍길동' }] });
  f.apply('DELMEM', 3, { name: '해달이' });
  f.apply('MSG', 4, { name: '일반메시지' });
  f.apply('NEWMEM', 5, { name: '해달이' });
  assert.doesNotMatch(f.body(5), /닉변 감지|타방이름|일반메시지/u);
  assert.deepEqual(f.store.recentNicknames(ROOM, MEMBER), ['홍길동', '해달이']);
  assert.deepEqual(f.store.recentNicknames(OTHER, MEMBER), ['타방이름']);
  assert.deepEqual(f.store.recentNicknames(ROOM, '321'), ['홍길동']);
  assert.throws(() => f.apply('NEWMEM', 6, { members: [{ nickName: '해달이' }] }), /invalid-id/);
});

test('long Unicode names stay intact in storage and before/after lines while public history fits', t => {
  const f = fixture(t, false, defaults);
  const names = Array.from({ length: 5 }, (_, index) => `${index}$&{}` + '👩‍🚀'.repeat(22) + '끝끝끝끝끝');
  for (const [index, name] of names.entries()) {
    if (index) f.apply('DELMEM', index * 2, { name: names[index - 1] });
    f.apply('NEWMEM', index * 2 + 1, { name });
  }
  const body = f.body(9);
  assert.ok(body.length <= 1000);
  assert.ok(body.isWellFormed());
  assert.ok(body.includes(`이전 닉네임: ${names[3]}\n✨ 변경 닉네임: ${names[4]}`));
  assert.match(body, /최근 닉네임 이력 \(5개\)\n.*…/u);
  assert.deepEqual(f.store.recentNicknames(ROOM, MEMBER), names);
});

test('backfill restores numeric sequence ordering and chronological names without creating new Outbox rows', t => {
  const f = fixture(t, false, defaults);
  f.apply('NEWMEM', 100, { name: '최신', at: again });
  const replay = (origin, seq, options) => f.store.apply(mapFrame(frame(origin, seq, options), defaults), { backfill: true });
  assert.equal(replay('KICKMEM', 99, { name: '중간', at: exit }), 'applied');
  assert.equal(replay('NEWMEM', 9, { name: '최초', at: first }), 'applied');
  assert.equal(replay('NEWMEM', 9, { name: '최초', at: first }), 'duplicate');
  assert.throws(() => replay('DELMEM', 99, { event: '101' }), /sequence-conflict-or-late/);
  f.reopen();
  assert.deepEqual(f.store.recentNicknames(ROOM, MEMBER), ['최초', '중간', '최신']);
  assert.deepEqual([f.member().first_join, f.member().last_join, f.member().last_exit], [first, again, exit]);
  assert.deepEqual([f.member().joins, f.member().exits, f.member().kicks], [2, 1, 1]);
  assert.deepEqual(f.store.status().outbox.map(row => [row.state, row.count]), [['discarded', 1]]);
});
