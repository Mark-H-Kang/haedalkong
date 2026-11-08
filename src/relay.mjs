import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { id, mapFrame } from './events.mjs';

const windowSize = 1000;
const exact = text => JSON.parse(text, (_, value, context) =>
  typeof value === 'number' ? context.source : value);
const digest = row => createHash('sha256').update(JSON.stringify([
  row.chat_id, row._id, row.id, row.created_at, row.type, row.v, row.message,
])).digest('hex');

export function irisReader(port, request = fetch) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid-iris-port');
  return async (room, cursor) => {
    const lower = cursor ? 'CAST(? AS INTEGER)' :
      'COALESCE((SELECT MAX(_id) FROM db1.chat_logs WHERE chat_id = ?), 1)';
    // Iris needs the sender ID to decrypt the system-message body, even though membership uses the feed subject.
    const query = 'SELECT chat_id,_id,id,user_id,created_at,type,v,CASE WHEN type=0 THEN message END AS message ' +
      'FROM db1.chat_logs WHERE chat_id = ? AND _id >= ' + lower + ' ORDER BY _id LIMIT ' + (windowSize + 1);
    const response = await request(`http://127.0.0.1:${port}/query`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, bind: [room, cursor ?? room] }),
    });
    if (!response.ok || !response.body) throw Error('relay-query-failed');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw Error('relay-window-limit');
      chunks.push(chunk);
    }
    const data = exact(Buffer.concat(chunks).toString('utf8'));
    if (data.error || !Array.isArray(data.data)) throw Error('relay-query-failed');
    return data.data;
  };
}

export class Relay {
  constructor(store) {
    if (store.rooms.size !== 1) throw Error('relay-single-room-required');
    this.store = store;
    this.room = [...store.rooms.keys()][0];
    this.db = store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS relay_cursor (
      room TEXT PRIMARY KEY, position TEXT NOT NULL, digest TEXT NOT NULL
    )`);
  }

  cursor() {
    return this.db.prepare('SELECT position, digest FROM relay_cursor WHERE room = ?').get(this.room);
  }

  async scan(read, { fresh = () => false, enabled = () => true } = {}) {
    const old = this.cursor();
    const rows = await read(this.room, old?.position);
    if (rows.length > windowSize || (!old && rows.length !== 1)) throw Error('relay-window-limit');
    if (old && (!rows.length || id(rows[0]._id) !== old.position || digest(rows[0]) !== old.digest)) {
      throw Error('relay-anchor-changed');
    }
    let position = 0n;
    const parsed = rows.map(row => {
      const seq = BigInt(id(row._id));
      if (id(row.chat_id) !== this.room || seq <= position) throw Error('relay-row-conflict');
      position = seq;
      return { row, batch: mapFrame(JSON.stringify({ json: row, msg: row.message }), this.store.rooms) };
    });
    return this.store.transaction(() => {
      const current = this.cursor();
      if (current?.position !== old?.position || current?.digest !== old?.digest) throw Error('relay-concurrent-scan');
      if (!enabled() || this.store.halted || this.store.unresolved().length) throw Error('relay-paused');
      if (!fresh()) this.db.prepare("UPDATE outbox SET state='discarded' WHERE room=? AND state='pending'").run(this.room);
      let applied = 0;
      for (const { batch } of parsed.slice(1)) {
        if (batch && this.store.applyInTransaction(batch, { backfill: !fresh() }) === 'applied') applied++;
      }
      const { row } = parsed.at(-1);
      this.db.prepare(`INSERT INTO relay_cursor VALUES (?, ?, ?) ON CONFLICT (room) DO UPDATE
        SET position = excluded.position, digest = excluded.digest`).run(this.room, row._id, digest(row));
      return applied;
    });
  }
}

export async function runRelay(relay, port, dispatch, enabled, signal, { notify = true } = {}) {
  const read = irisReader(port);
  while (!signal.aborted) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let disconnected = false;
    const closed = () => { disconnected = true; };
    ws.addEventListener('close', closed);
    ws.addEventListener('error', closed);
    try {
      for (let i = 0; i < 20 && !disconnected && !signal.aborted && ws.readyState !== WebSocket.OPEN; i++) {
        await delay(250);
      }
      if (ws.readyState === WebSocket.OPEN && !signal.aborted && enabled()) {
        // Each new connection reconciles the retained anchor with the source. No catch-up notices.
        await relay.scan(read, { enabled });
        let hint = false;
        ws.addEventListener('message', ({ data }) => {
          if (typeof data !== 'string' || Buffer.byteLength(data) > 1024 * 1024) return;
          try { if (exact(data)?.json?.chat_id === relay.room) hint = true; } catch {}
        });
        let nextPoll = 0;
        while (!disconnected && !signal.aborted && enabled()) {
          if (hint || Date.now() >= nextPoll) {
            hint = false;
            await relay.scan(read, {
              fresh: () => notify && !disconnected && !signal.aborted && enabled(), enabled,
            });
            if (notify && !disconnected && !signal.aborted && enabled()) await dispatch();
            nextPoll = Date.now() + 3000;
          }
          await delay(250);
        }
      }
    } catch (error) {
      if (error.message === 'relay-paused' || signal.aborted) return;
      relay.store.halt();
      throw error;
    } finally {
      ws.close();
    }
    if (!enabled()) return;
    await delay(2000);
  }
}
