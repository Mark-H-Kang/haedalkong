import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdtempSync, openSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { maxNoticeLength, projectMember, renderNotice } from './membership.mjs';

const applicationId = 0x4f4d4231;
// Leave headroom below Iris's 120-second ceiling for Windows/Android clock skew.
const noticeTtlSeconds = 110;
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

const membershipSchema = `
  ALTER TABLE members ADD COLUMN first_join INTEGER;
  ALTER TABLE members ADD COLUMN last_join INTEGER;
  ALTER TABLE members ADD COLUMN last_exit INTEGER;
  ALTER TABLE members ADD COLUMN joins INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN leaves INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN kicks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE members ADD COLUMN exits INTEGER GENERATED ALWAYS AS (leaves + kicks) VIRTUAL;
  CREATE TABLE nicknames (
    room TEXT NOT NULL, member TEXT NOT NULL, event TEXT NOT NULL, name TEXT NOT NULL,
    PRIMARY KEY (room, member, event),
    FOREIGN KEY (room, event, member) REFERENCES history (room, event, member)
  );
`;

function databaseVersion(db) {
  if (db.prepare('PRAGMA application_id').get().application_id !== applicationId) throw Error('database-identity');
  return db.prepare('PRAGMA user_version').get().user_version;
}

function readVersion(file) {
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.nlink !== 1) throw Error('unsafe-database-path');
  const probe = new DatabaseSync(file, { readOnly: true });
  try {
    return databaseVersion(probe);
  } finally {
    probe.close();
  }
}

function backupLegacy(file, version) {
  const dir = mkdtempSync(join(dirname(file), `${basename(file)}.backup-`));
  const backup = join(dir, 'before-migration.sqlite');
  // The caller holds the writer reservation. This second connection reads the last committed snapshot.
  const source = new DatabaseSync(file, { readOnly: true });
  try {
    source.exec('PRAGMA synchronous = FULL');
    source.prepare('VACUUM INTO ?').run(backup);
  } finally {
    source.close();
  }
  if (readVersion(backup) !== version) throw Error('backup-version-mismatch');
  const check = new DatabaseSync(backup, { readOnly: true });
  try {
    if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('backup-integrity-failed');
  } finally {
    check.close();
  }
  const handle = openSync(backup, 'r+');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  return backup;
}

export class Store {
  constructor(file, rooms, { live = false, migrate = false } = {}) {
    const legacy = live ? 2 : 1;
    const current = legacy + 2;
    let created = false;
    if (!migrate) {
      try {
        closeSync(openSync(file, 'wx'));
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    const requireVersion = version => {
      if (version === legacy && !migrate) throw Error('migration-required');
      if (version !== legacy && version !== current) throw Error('database-identity');
    };
    if (!created) requireVersion(readVersion(file));
    this.db = new DatabaseSync(file);
    this.rooms = rooms;
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
      this.transaction(() => {
        const version = created ? null : databaseVersion(this.db);
        if (!created) requireVersion(version);
        if (created || version === legacy) {
          if (created) this.db.exec(schema);
          else this.migrationBackup = backupLegacy(file, legacy);
          this.db.exec(membershipSchema);
          if (!created) this.rebuildLegacyProjection();
          this.db.exec(`PRAGMA application_id = ${applicationId}; PRAGMA user_version = ${current};`);
        }
        if (live && !migrate) this.bindRooms();
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  rebuildLegacyProjection() {
    const members = this.db.prepare('SELECT DISTINCT room, member FROM history').all();
    for (const { room, member } of members) this.reproject(room, member);
    // Legacy pending text may disclose kicks. Preserve the rows and prior delivery decisions.
    this.db.exec("UPDATE outbox SET state = 'discarded' WHERE state = 'pending'");
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
    if (this.db.prepare('SELECT room FROM bindings').all().some(({ room }) => !this.rooms.has(room))) {
      throw Error('database-room-mismatch');
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
    return this.transaction(() => this.applyInTransaction(batch, { backfill }));
  }

  applyInTransaction(batch, { backfill = false } = {}) {
    if (!batch || !this.rooms.has(batch.room)) return 'ignored';
    const { room, event, sequence, seconds, kind, members } = batch;
    const digest = createHash('sha256').update(JSON.stringify([sequence, seconds, kind, members])).digest('hex');
    if (!this.db.isTransaction) throw Error('relay-transaction-required');
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
    for (const member of members) {
      if (late) {
        this.db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, NULL)').run(room, event, member.id, member.name);
        this.reproject(room, member.id);
      } else {
        this.applyMember(batch, member, backfill);
      }
    }
    if (backfill) this.db.prepare("UPDATE outbox SET state = 'discarded' WHERE room = ? AND state = 'pending'").run(room);
    if (late) return 'applied';
    this.db.prepare(`
      INSERT INTO cursors VALUES (?, ?)
      ON CONFLICT (room) DO UPDATE SET sequence = excluded.sequence
    `).run(room, sequence);
    return 'applied';
  }

  applyMember({ room, event, kind, seconds }, { id, name }, backfill) {
    const previous = this.db.prepare('SELECT * FROM members WHERE room = ? AND member = ?').get(room, id);
    const state = projectMember(previous, kind, name, seconds);
    const { transition } = state;
    this.db.prepare('INSERT INTO history VALUES (?, ?, ?, ?, ?)').run(room, event, id, name, transition);
    this.saveMember(room, id, state);
    if (state.observedName) this.saveNickname(room, id, event, name);
    if (!transition || backfill) return;
    const key = `haedalkong-v1:${room}:${event}:${id}`;
    const recent = transition === 'rejoin' && state.observedName && previous?.name
      ? this.recentNicknames(room, id) : [];
    const body = renderNotice(state, this.rooms.get(room).templates, previous?.name, recent);
    if (body.length > maxNoticeLength) throw Error('rendered-message-too-long');
    this.db.prepare("INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)")
      .run(key, room, event, id, body, seconds + noticeTtlSeconds);
  }

  saveMember(room, id, state) {
    this.db.prepare(`
      INSERT INTO members (room, member, name, seen_join, inside, first_join, last_join, last_exit, joins, leaves, kicks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (room, member) DO UPDATE SET
        name = excluded.name, seen_join = excluded.seen_join, inside = excluded.inside,
        first_join = excluded.first_join, last_join = excluded.last_join, last_exit = excluded.last_exit,
        joins = excluded.joins, leaves = excluded.leaves, kicks = excluded.kicks
    `).run(room, id, state.name, state.seen_join, state.inside, state.first_join, state.last_join,
      state.last_exit, state.joins, state.leaves, state.kicks);
  }

  saveNickname(room, member, event, name) {
    this.db.prepare('INSERT INTO nicknames (room, member, event, name) VALUES (?, ?, ?, ?)').run(room, member, event, name);
  }

  recentNicknames(room, member) {
    return this.db.prepare(`
      SELECT n.name FROM nicknames n JOIN frames f USING (room, event)
      WHERE n.room = ? AND n.member = ?
      ORDER BY length(f.sequence) DESC, f.sequence DESC LIMIT 5
    `).all(room, member).reverse().map(row => row.name);
  }

  reproject(room, member) {
    const rows = this.db.prepare(`
      SELECT h.event, h.name, f.kind, f.seconds FROM history h JOIN frames f USING (room, event)
      WHERE h.room = ? AND h.member = ? ORDER BY length(f.sequence), f.sequence
    `).all(room, member);
    const update = this.db.prepare('UPDATE history SET transition = ? WHERE room = ? AND event = ? AND member = ?');
    this.db.prepare('DELETE FROM nicknames WHERE room = ? AND member = ?').run(room, member);
    let state;
    for (const row of rows) {
      state = projectMember(state, row.kind, row.name, row.seconds);
      update.run(state.transition, room, row.event, member);
      if (state.observedName) this.saveNickname(room, member, row.event, row.name);
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
