import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { loadConfig } from '../src/events.mjs';
import { Store } from '../src/store.mjs';

// Original DDL from 779bc5f. All rows below are synthetic.
const legacySchema = readFileSync(new URL('./legacy-schema.sql', import.meta.url), 'utf8');
const room = '101';
const member = '123';
const rooms = loadConfig(JSON.stringify({ liveEnabled: true,
  rooms: { [room]: { profileRef: 'sample-profile', verificationRef: 'sample-proof' } },
})).rooms;

function legacyFixture(t, live) {
  const dir = mkdtempSync(join(tmpdir(), 'haedalkong-migration-'));
  const file = join(dir, 'legacy.sqlite');
  const source = new DatabaseSync(file);
  t.after(() => {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // Keep this connection open so the live case exercises a committed WAL.
  if (live) source.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  source.exec(legacySchema);
  source.exec(`PRAGMA application_id = 0x4f4d4231; PRAGMA user_version = ${live ? 2 : 1};`);
  if (live) source.exec("INSERT INTO bindings VALUES ('101', 'sample-profile', 'sample-proof');");
  const batch = { room, event: '10', sequence: '100', seconds: 1794096000,
    kind: 'join', members: [{ id: member, name: '콩' }] };
  const digest = createHash('sha256').update(JSON.stringify([batch.sequence, batch.seconds, batch.kind, batch.members]))
    .digest('hex');
  source.prepare('INSERT INTO frames VALUES (?, ?, ?, ?, ?, ?)').run(room, batch.event, batch.sequence,
    digest, batch.seconds, batch.kind);
  source.exec(`
    INSERT INTO frames VALUES ('101', '11', '101', 'fixture', 1794096060, 'kick');
    INSERT INTO frames VALUES ('101', '12', '102', 'fixture', 1794096120, 'join');
    INSERT INTO cursors VALUES ('101', '102');
    INSERT INTO members VALUES ('101', '123', '바다', 1, 1);
    INSERT INTO history VALUES ('101', '10', '123', '콩', 'join');
    INSERT INTO history VALUES ('101', '11', '123', '콩', 'kick');
    INSERT INTO history VALUES ('101', '12', '123', '바다', 'rejoin');
    INSERT INTO outbox VALUES ('accepted-key', '101', '10', '123', 'legacy accepted', 1794096120, 'accepted', 'receipt');
    INSERT INTO outbox VALUES ('pending-key', '101', '11', '123', 'legacy kick', 1794096180, 'pending', NULL);
    INSERT INTO outbox VALUES ('uncertain-key', '101', '12', '123', 'legacy unclear', 1794096240, 'uncertain', NULL);
  `);
  return { dir, file, source, batch };
}

for (const live of [false, true]) {
  test(`legacy ${live ? 'live WAL' : 'replay'} database is backed up, migrated in place, and deduplicates after restart`, t => {
    const f = legacyFixture(t, live);
    const version = live ? 2 : 1;
    assert.throws(() => new Store(f.file, rooms, { live }), /migration-required/);
    assert.throws(() => new Store(f.file, rooms, { live: !live, migrate: true }), /database-identity/);
    assert.equal(f.source.prepare('PRAGMA user_version').get().user_version, version);
    const migrated = new Store(f.file, rooms, { live, migrate: true });
    const backup = new DatabaseSync(migrated.migrationBackup, { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, version);
      assert.equal(backup.prepare("SELECT state FROM outbox WHERE key = 'pending-key'").get().state, 'pending');
      assert.equal(backup.prepare('SELECT count(*) AS n FROM history').get().n, 3);
      assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, version + 2);
      assert.equal(migrated.db.prepare('PRAGMA foreign_key_check').all().length, 0);
      assert.deepEqual(migrated.recentNicknames(room, member), ['콩', '바다']);
      assert.deepEqual({ ...migrated.db.prepare(
        'SELECT first_join, last_join, last_exit, joins, exits, leaves, kicks FROM members'
      ).get() }, { first_join: 1794096000, last_join: 1794096120, last_exit: 1794096060,
        joins: 2, exits: 1, leaves: 0, kicks: 1 });
      assert.equal(migrated.db.prepare("SELECT receipt FROM outbox WHERE key = 'accepted-key'").get().receipt, 'receipt');
      assert.equal(migrated.db.prepare("SELECT state FROM outbox WHERE key = 'pending-key'").get().state, 'discarded');
      assert.equal(migrated.db.prepare("SELECT state FROM outbox WHERE key = 'uncertain-key'").get().state, 'uncertain');
      assert.equal(migrated.status().cursors[0].sequence, '102');
    } finally {
      backup.close();
      migrated.close();
    }
    const reopened = new Store(f.file, rooms, { live });
    try {
      assert.equal(reopened.apply(f.batch), 'duplicate');
      assert.throws(() => reopened.claim(f.batch.seconds), /dispatch-halted/);
      assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM outbox').get().n, 3);
    } finally {
      reopened.close();
    }
    const noOp = new Store(f.file, rooms, { live, migrate: true });
    try {
      assert.equal(noOp.migrationBackup, undefined);
      assert.equal(readdirSync(f.dir).filter(path => path.startsWith('legacy.sqlite.backup-')).length, 1);
    } finally {
      noOp.close();
    }
  });
}

test('failed projection rolls back migration and leaves the verified pre-migration backup', t => {
  const f = legacyFixture(t, false);
  f.source.exec(`CREATE TRIGGER block_migration BEFORE UPDATE ON history
    BEGIN SELECT RAISE(ABORT, 'fixture-migration-fault'); END;`);
  assert.throws(() => new Store(f.file, rooms, { migrate: true }), /fixture-migration-fault/);
  assert.equal(f.source.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(f.source.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'nicknames'").get().n, 0);
  assert.equal(f.source.prepare("SELECT state FROM outbox WHERE key = 'pending-key'").get().state, 'pending');
  assert.equal(readdirSync(f.dir).filter(path => path.startsWith('legacy.sqlite.backup-')).length, 1);
});
