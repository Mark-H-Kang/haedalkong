import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectRoomLane } from '../src/room-lane.mjs';
import { loadConfig } from '../src/events.mjs';
import { Store } from '../src/store.mjs';
import { Gateway } from '../src/gateway.mjs';
import { Relay } from '../src/relay.mjs';

test('room allowlist pins primary storage and gives the same member independent history, cursor and STOP', async () => {
  const now = 1794096000;
  const config = loadConfig(JSON.stringify({ liveEnabled: true, primaryRoom: '200', rooms: {
    200: { profileRef: 'first', verificationRef: 'proof-first' },
    300: { profileRef: 'second', verificationRef: 'proof-second' },
  } }));
  assert.equal(selectRoomLane(config).room, '200');
  assert.throws(() => selectRoomLane(config, '999'), /room-not-allowed/);
  assert.throws(() => selectRoomLane({ ...config, primaryRoom: '999' }), /primary-room-required/);
  const dir = mkdtempSync(join(tmpdir(), 'hk-lanes-'));
  const stores = [], gateways = [];
  try {
    for (const [index, room] of ['200', '300'].entries()) {
      const { rooms } = selectRoomLane(config, room);
      const store = new Store(join(dir, `live-${room}.sqlite`), rooms, { live: true });
      stores.push(store);
      const relay = new Relay(store);
      await relay.scan(async () => [{ chat_id: room, _id: '1', id: '1', type: '1',
        created_at: String(now), v: '{"origin":"MSG"}', message: null }]);
      assert.equal(relay.cursor().position, '1');
      const token = String(index + 1).repeat(43);
      const gateway = new Gateway(join(dir, `writer-${room}.sqlite`), {
        mainRoom: '100', rooms, token, irisToken: 'i'.repeat(43), clock: () => now,
        permitted: () => index === 0,
      });
      gateways.push(gateway);
      const batch = { room, event: '2', sequence: '2', seconds: now, kind: 'join',
        members: [{ id: '7', name: `room-${room}` }] };
      assert.equal(store.apply({ ...batch, room: '999' }), 'ignored');
      assert.equal(store.apply(batch), 'applied');
      assert.equal(store.apply(batch), 'duplicate');
      const { profileRef, verificationRef } = rooms.get(room);
      const payload = { key: `haedalkong-v1:${room}:2:7`, roomId: room, profileRef, verificationRef,
        text: 'synthetic', expiresAt: now + 110 };
      assert.equal(gateway.accept(`Bearer ${token}`, { ...payload, roomId: '100' }).status, 403);
      assert.equal(gateway.accept(`Bearer ${token}`, { ...payload, profileRef: 'wrong' }).status, 403);
      assert.equal(gateway.accept(`Bearer ${token}`, payload).status, index === 0 ? 202 : 503);
      if (index === 1) assert.equal(gateways[0].accept('Bearer ' + '1'.repeat(43), payload).status, 403);
    }
    assert.deepEqual(stores.map(s => s.db.prepare('SELECT name FROM members').get().name), ['room-200', 'room-300']);
  } finally {
    for (const g of gateways) g.db.close();
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
