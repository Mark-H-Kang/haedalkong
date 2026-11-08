import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { id } from './events.mjs';
import { maxNoticeLength } from './membership.mjs';

const clockSeconds = () => Math.floor(Date.now() / 1000);
const appId = 0x484b4731;
const hash = text => createHash('sha256').update(text).digest();

export function secret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(value)) throw Error('invalid-writer-secret');
  return value;
}

export function irisSender(port, token, request = fetch) {
  secret(token);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid-iris-port');
  return async payload => {
    const response = await request(`http://127.0.0.1:${port}/reply/haedalkong`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(4000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await response.body?.cancel();
    if (response.status !== 204) throw Object.assign(Error('iris-delivery-uncertain'), { irisStatus: response.status });
  };
}

export class Gateway {
  constructor(file, { mainRoom, rooms, token, irisToken, permitted, send, probe, clock = clockSeconds,
    onProgress = () => {} }) {
    id(mainRoom);
    if (rooms.size !== 1 || rooms.has(mainRoom)) throw Error('invalid-writer-scope');
    this.rooms = rooms;
    this.tokenHash = hash(`Bearer ${secret(token)}`);
    this.irisHash = hash(`Bearer ${secret(irisToken)}`);
    if (timingSafeEqual(this.tokenHash, this.irisHash)) throw Error('writer-secret-collision');
    this.permitted = permitted;
    this.send = send;
    this.probe = probe;
    this.clock = clock;
    this.onProgress = onProgress;
    let created = false;
    try {
      closeSync(openSync(file, 'wx'));
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const entry = lstatSync(file);
      if (!entry.isFile() || entry.nlink !== 1) throw Error('unsafe-writer-path');
      const probe = new DatabaseSync(file, { readOnly: true });
      try {
        if (probe.prepare('PRAGMA application_id').get().application_id !== appId ||
            probe.prepare('PRAGMA user_version').get().user_version !== 1) throw Error('writer-database-identity');
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
      if (created) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE outbox (key TEXT PRIMARY KEY, payload TEXT NOT NULL, receipt TEXT NOT NULL,
          state TEXT NOT NULL, attempted INTEGER);
        CREATE INDEX writer_attempts ON outbox(attempted);
        PRAGMA application_id=${appId}; PRAGMA user_version=1; COMMIT;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  valid({ key, roomId, profileRef, verificationRef, text, expiresAt }, now) {
    const binding = this.rooms.get(roomId);
    if (this.probe && (this.probe.key !== key || this.probe.text !== text)) return false;
    if (!binding || binding.profileRef !== profileRef || binding.verificationRef !== verificationRef ||
        typeof key !== 'string' || typeof text !== 'string' || !text.trim() || text.length > maxNoticeLength ||
        !text.isWellFormed() || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 120) return false;
    const [prefix, room, event, member, extra] = key.split(':');
    if (prefix !== 'haedalkong-v1' || room !== roomId || extra !== undefined) return false;
    try { return Boolean(id(event) && id(member)); } catch { return false; }
  }

  accept(header, body) {
    if (typeof header !== 'string' || !timingSafeEqual(hash(header), this.tokenHash)) return { status: 401 };
    const { key, roomId, profileRef, verificationRef, text, expiresAt } = body ?? {};
    const payload = { key, roomId, profileRef, verificationRef, text, expiresAt };
    if (!this.valid(payload, this.clock())) return { status: 403 };
    if (!this.permitted()) return { status: 503 };
    const encoded = JSON.stringify(payload);
    const receipt = randomUUID();
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO outbox
      SELECT ?, ?, ?, 'pending', NULL WHERE NOT EXISTS (
        SELECT 1 FROM outbox WHERE state='uncertain'
      )`).run(key, encoded, receipt);
    const record = this.db.prepare('SELECT payload, receipt, state FROM outbox WHERE key=?').get(key);
    if (!record) return { status: 503 };
    if (record.payload !== encoded || ['discarded', 'expired', 'isolated-uncertain'].includes(record.state)) return { status: 409 };
    if (inserted.changes) this.progress('accepted', payload);
    return { status: 202, body: { status: 'accepted', key, roomId, profileRef, receipt: record.receipt } };
  }

  progress(stage, { key, expiresAt }, irisStatus) {
    this.onProgress({ stage, ref: hash(key).toString('hex').slice(0, 16), at: new Date().toISOString(), expiresAt,
      ...(Number.isInteger(irisStatus) ? { irisStatus } : {}) });
  }

  async sendNext() {
    if (!this.permitted()) return false;
    const now = this.clock();
    // Expired pending rows do not consume quota.
    this.db.prepare(`UPDATE outbox SET state='expired' WHERE state='pending'
      AND json_extract(payload, '$.expiresAt') <= ?`).run(now);
    // One durable claim globally. Iris still provides device-wide pacing.
    const claim = this.db.prepare(`
      UPDATE outbox SET state='sending', attempted=? WHERE rowid=(
        SELECT rowid FROM outbox WHERE state='pending' ORDER BY rowid LIMIT 1
      ) AND NOT EXISTS (SELECT 1 FROM outbox WHERE state IN ('sending', 'authorized', 'uncertain'))
      AND ? >= COALESCE((SELECT MAX(attempted) FROM outbox), 0)
      RETURNING key, payload
    `).get(now, now);
    if (!claim) return false;
    const finish = state => this.db.prepare(
      "UPDATE outbox SET state=? WHERE key=? AND state IN ('sending', 'authorized')"
    ).run(state, claim.key);
    const payload = JSON.parse(claim.payload);
    if (payload.expiresAt <= this.clock()) {
      finish('expired');
      return true;
    }
    if (payload.key !== claim.key || !this.valid(payload, this.clock()) || !this.permitted()) {
      finish('discarded');
      return true;
    }
    this.progress('iris-request', payload);
    try {
      await this.send(payload);
      if (this.db.prepare('SELECT state FROM outbox WHERE key=?').get(claim.key)?.state !== 'authorized') {
        throw Error('iris-authorization-missing');
      }
    } catch (error) {
      finish('uncertain');
      this.progress('uncertain', payload, error?.irisStatus);
      return false;
    }
    finish('submitted');
    this.progress('submitted', payload, 204);
    return true;
  }

  authorizeSend(header, body) {
    if (typeof header !== 'string' || !timingSafeEqual(hash(header), this.irisHash)) return 401;
    const { key, roomId, profileRef, verificationRef, text, expiresAt } = body ?? {};
    const payload = { key, roomId, profileRef, verificationRef, text, expiresAt };
    if (!this.valid(payload, this.clock()) || !this.permitted()) return 403;
    const decision = this.db.prepare(`UPDATE outbox SET state='authorized'
      WHERE key=? AND payload=? AND state='sending'`).run(key, JSON.stringify(payload));
    if (decision.changes === 1) this.progress('android-authorized', payload);
    return decision.changes === 1 ? 204 : 409;
  }
}

export function gatewayServer(gateway) {
  return createServer({ requestTimeout: 5000, headersTimeout: 4000 }, async (req, res) => {
    let result = { status: 404 };
    if (req.method === 'POST' && ['/v1/haedalkong/enqueue', '/internal/haedalkong/authorize'].includes(req.url)) {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 8192) throw Error('invalid-payload');
          chunks.push(chunk);
        }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        result = req.url === '/v1/haedalkong/enqueue'
          ? gateway.accept(req.headers.authorization, body)
          : { status: gateway.authorizeSend(req.headers.authorization, body) };
      } catch {
        result = { status: 400 };
      }
    }
    res.writeHead(result.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result.body ?? {}));
  });
}
