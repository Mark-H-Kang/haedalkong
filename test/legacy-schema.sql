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
