import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const applicationId = 0x4f4d4231;
const schema = `
  CREATE TABLE control (id INTEGER PRIMARY KEY CHECK (id = 1), halted INTEGER NOT NULL);
  INSERT INTO control VALUES (1, 0);
  CREATE TABLE bindings (room TEXT PRIMARY KEY, profile TEXT NOT NULL, proof TEXT NOT NULL);
  CREATE TABLE frames (
    room TEXT NOT NULL, event TEXT NOT NULL, sequence TEXT NOT NULL, digest TEXT NOT NULL,
    seconds INTEGER NOT NULL, kind TEXT NOT NULL,
    PRIMARY KEY (room, event), UNIQUE (room, sequence)
  );
  CREATE TABLE cursors (room TEXT PRIMARY KEY, sequence TEXT NOT NULL);
  CREATE TABLE members (
    room TEXT NOT NULL, member TEXT NOT NULL, name TEXT,
    seen_join INTEGER NOT NULL, inside INTEGER NOT NULL,
    PRIMARY KEY (room, member)
  );
  CREATE TABLE history (
    room TEXT NOT NULL, event TEXT NOT NULL, member TEXT NOT NULL,
    name TEXT, transition TEXT,
    PRIMARY KEY (room, event, member),
    FOREIGN KEY (room, event) REFERENCES frames (room, event)
  );
  CREATE INDEX member_history ON history (room, member);
  CREATE TABLE outbox (
    key TEXT PRIMARY KEY, room TEXT NOT NULL, event TEXT NOT NULL, member TEXT NOT NULL,
    body TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, receipt TEXT,
    FOREIGN KEY (room, event, member) REFERENCES history (room, event, member)
  );
  CREATE INDEX pending_outbox ON outbox (state, room);
`;

function projectMember(previous, kind, name) {
  const inside = Number(kind === 'join');
  const transition = previous?.inside === inside
    ? null
    : inside && previous?.seen_join ? 'rejoin' : kind;
  return { transition, name: name ?? previous?.name ?? null,
    seen_join: Number(Boolean(inside || previous?.seen_join)), inside };
}

export class Store {
  constructor(file, rooms, { live = false } = {}) {
    let created = false;
    try {
      closeSync(openSync(file, 'wx'));
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const entry = lstatSync(file);
      if (!entry.isFile() || entry.nlink !== 1) throw Error('unsafe-database-path');
      // Refuse unrelated databases before opening a writable SQLite connection.
      const probe = new DatabaseSync(file, { readOnly: true });
      try {
        if (probe.prepare('PRAGMA application_id').get().application_id !== applicationId ||
            probe.prepare('PRAGMA user_version').get().user_version !== (live ? 2 : 1)) {
          throw Error('database-identity');
        }
      } finally {
        probe.close();
      }
    }
    this.db = new DatabaseSync(file);
    this.rooms = rooms;
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
      this.transaction(() => {
        if (created) {
          this.db.exec(schema);
          this.db.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${live ? 2 : 1};`);
        }
        if (live) this.bindRooms();
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  bindRooms() {
    const get = this.db.prepare('SELECT profile, proof FROM bindings WHERE room = ?');
    const insert = this.db.prepare('INSERT INTO bindings VALUES (?, ?, ?)');
    for (const [room, { profileRef, verificationRef }] of this.rooms) {
      const saved = get.get(room);
      if (!saved) insert.run(room, profileRef, verificationRef);
      else if (saved.profile !== profileRef || saved.proof !== verificationRef) throw Error('binding-changed');
    }
  }

  get halted() {
    return Boolean(this.db.prepare('SELECT halted FROM control WHERE id = 1').get().halted);
  }

  halt() {
    this.db.exec('UPDATE control SET halted = 1 WHERE id = 1');
  }

  unresolved() {
    return this.db.prepare("SELECT key, state FROM outbox WHERE state IN ('sending', 'uncertain') ORDER BY rowid").all();
  }

  resume() {
    this.transaction(() => {
      if (this.unresolved().length) throw Error('unresolved-delivery');
      this.db.exec('UPDATE control SET halted = 0 WHERE id = 1');
    });
  }

  resolve(key, decision) {
    if (!['accepted', 'discarded'].includes(decision)) throw Error('invalid-resolution');
    this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE outbox SET state = ?, receipt = 'operator'
        WHERE key = ? AND state IN ('sending', 'uncertain')
      `).run(decision, key);
      if (result.changes !== 1) throw Error('unresolved-key-required');
      this.halt();
    });
  }

  apply(batch, { backfill = false } = {}) {
    if (!batch || !this.rooms.has(batch.room)) return 'ignored';
    const { room, event, sequence, seconds, kind, members } = batch;
    const digest = createHash('sha256').update(JSON.stringify([sequence, seconds, kind, members])).digest('hex');
    return this.transaction(() => {
      if (this.halted && !backfill) throw Error('store-halted');
      const old = this.db.prepare('SELECT digest FROM frames WHERE room = ? AND event = ?').get(room, event);
      if (old) {
        if (old.digest !== digest) throw Error('event-conflict');
        return 'duplicate';
      }
      const cursor = this.db.prepare('SELECT sequence FROM cursors WHERE room = ?').get(room);
      const late = cursor && BigInt(sequence) <= BigInt(cursor.sequence);
      if (late && (!backfill || this.db.prepare('SELECT 1 FROM frames WHERE room = ? AND sequence = ?')
        .get(room, sequence))) throw Error('sequence-conflict-or-late');
      this.db.prepare('INSERT INTO frames VALUES (?, ?, ?, ?, ?, ?)').run(room, event, sequence, digest, seconds, kind);
      for (const member of members) this.applyMember(batch, member, backfill);
      if (backfill) this.db.prepare("UPDATE outbox SET state = 'discarded' WHERE room = ? AND state = 'pending'").run(room);
      if (late) {
        for (const member of members) this.reproject(room, member.id);
        return 'applied';
      }
      this.db.prepare(`
        INSERT INTO cursors VALUES (?, ?)
        ON CONFLICT (room) DO UPDATE SET sequence = excluded.sequence
      `).run(room, sequence);
      return 'applied';
    });
  }

  applyMember({ room, event, kind, seconds }, { id, name }, backfill) {
    const previous = this.db.prepare('SELECT * FROM members WHERE room = ? AND member = ?').get(room, id);
    const state = projectMember(previous, kind, name);
    const { transition } = state;
    this.db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?)').run(room, event, id, name, transition);
    this.saveMember(room, id, state);
    if (!transition || backfill) return;
    const key = `haedalkong-v1:${room}:${event}:${id}`;
    const body = this.rooms.get(room).templates[transition].replaceAll('{name}', () => state.name ?? '회원');
    if (body.length > 1000) throw Error('rendered-message-too-long');
    this.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)")
      .run(key, room, event, id, body, seconds + 120);
  }

  saveMember(room, id, state) {
    this.db.prepare(`
      INSERT INTO members VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (room, member) DO UPDATE SET
        name = excluded.name, seen_join = excluded.seen_join, inside = excluded.inside
    `).run(room, id, state.name, state.seen_join, state.inside);
  }

  reproject(room, member) {
    const rows = this.db.prepare(`
      SELECT h.event, h.name, f.kind FROM history h JOIN frames f USING (room, event)
      WHERE h.room = ? AND h.member = ? ORDER BY length(f.sequence), f.sequence
    `).all(room, member);
    const update = this.db.prepare('UPDATE history SET transition = ? WHERE room = ? AND event = ? AND member = ?');
    let state;
    for (const row of rows) {
      state = projectMember(state, row.kind, row.name);
      update.run(state.transition, room, row.event, member);
    }
    this.saveMember(room, member, state);
  }

  claim(now) {
    return this.transaction(() => {
      if (this.halted || this.unresolved().length) throw Error('dispatch-halted');
      this.db.prepare("UPDATE outbox SET state = 'expired' WHERE state = 'pending' AND expires <= ?").run(now);
      const row = this.db.prepare(`
        SELECT key, room, body, expires FROM outbox WHERE state = 'pending'
          AND expires <= ? AND room IN (SELECT value FROM json_each(?))
        ORDER BY rowid LIMIT 1
      `).get(now + 120, JSON.stringify([...this.rooms.keys()]));
      if (!row) return null;
      this.db.prepare("UPDATE outbox SET state = 'sending' WHERE key = ?").run(row.key);
      return row;
    });
  }

  finish(key, state, receipt = null) {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE outbox SET state = ?, receipt = ? WHERE key = ? AND state = 'sending'")
        .run(state, receipt, key);
      if (result.changes !== 1) throw Error('claim-lost');
      if (state === 'uncertain') this.halt();
    });
  }

  status() {
    return {
      halted: this.halted,
      cursors: this.db.prepare('SELECT * FROM cursors ORDER BY room').all(),
      history: this.db.prepare('SELECT transition, count(*) AS count FROM history GROUP BY transition').all(),
      outbox: this.db.prepare('SELECT state, count(*) AS count FROM outbox GROUP BY state').all(),
      unresolved: this.unresolved(),
    };
  }
}
