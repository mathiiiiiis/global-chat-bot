// ==== store ====
//
// SQLite persistence using node:sqlite
//
// > channels   – channels in global network
// > relays     – relay mappings for edit/delete recovery after restarts
//
// no message content is stored, only ids and header metadata needed to
// rebuild relays. node:sqlite is synchronous, which keeps access simple
// and writes durable

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

class Store {
  // > dbPath         – where sqlite file lives
  // > logger         – scoped logger
  // > legacyJsonPat  – optional old JSON file to import on first run
  constructor(dbPath, logger, legacyJsonPath) {
    this.dbPath = dbPath;
    this.log = logger;
    this.legacyJsonPath = legacyJsonPath || null;
    this.db = null;
  }

  // ==== lifecycle ====
  load() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        channel_id  TEXT PRIMARY KEY,
        server_id   TEXT,
        server_name TEXT,
        added_by    TEXT,
        added_at    INTEGER
      );
      CREATE TABLE IF NOT EXISTS relays (
        origin_id    TEXT NOT NULL,
        author_name  TEXT,
        server_id    TEXT,
        server_name  TEXT,
        dest_channel TEXT NOT NULL,
        dest_id      TEXT NOT NULL,
        show_header  INTEGER NOT NULL DEFAULT 1,
        at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relays_origin ON relays (origin_id);
      CREATE INDEX IF NOT EXISTS idx_relays_at ON relays (at);
    `);

    this._migrateFromJson();

    const count = this.db.prepare("SELECT COUNT(*) AS n FROM channels").get().n;
    this.log.info(`store ready, ${count} synced channel(s)`);
    return this;
  }

  //one-time: import legacy JSON data on first run only
  _migrateFromJson() {
    if (!this.legacyJsonPath) return;
    const empty = this.db.prepare("SELECT COUNT(*) AS n FROM channels").get().n === 0;
    if (!empty) return;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.legacyJsonPath, "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") this.log.warn("could not read legacy json, skipping", err);
      return;
    }
    const channels = (parsed && parsed.channels) || {};
    const entries = Object.values(channels);
    if (!entries.length) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO channels (channel_id, server_id, server_name, added_by, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const c of entries) {
      insert.run(
        c.channelId,
        c.serverId || null,
        c.serverName || null,
        c.addedBy || null,
        c.addedAt || Date.now(),
      );
    }
    this.log.info(`migrated ${entries.length} channel(s) from legacy json`);
  }

  // ==== channels: read ====
  listChannels() {
    return this.db
      .prepare(
        `SELECT channel_id AS channelId, server_id AS serverId, server_name AS serverName, added_by AS addedBy, added_at AS addedAt
         FROM channels`,
      )
      .all();
  }

  listChannelIds() {
    return this.db
      .prepare("SELECT channel_id AS id FROM channels")
      .all()
      .map((r) => r.id);
  }

  hasChannel(channelId) {
    return Boolean(this.db.prepare("SELECT 1 FROM channels WHERE channel_id = ?").get(channelId));
  }

  getChannel(channelId) {
    return this.db
      .prepare(
        `SELECT channel_id AS channelId, server_id AS serverId, server_name AS serverName,
                added_by AS addedBy, added_at AS addedAt
         FROM channels WHERE channel_id = ?`,
      )
      .get(channelId);
  }

  // ==== channels: write ====
  //
  // entry: { channelId, serverId, serverName, addedBy }
  addChannel(entry) {
    this.db
      .prepare(
        `INSERT INTO channels (channel_id, server_id, server_name, added_by, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           server_id = excluded.server_id,
           server_name = excluded.server_name,
           added_by = excluded.added_by,
           added_at = excluded.added_at`,
      )
      .run(
        entry.channelId,
        entry.serverId || null,
        entry.serverName || null,
        entry.addedBy || null,
        Date.now(),
      );
    this.log.debug(`store add ${entry.channelId}`, { server: entry.serverName });
  }

  removeChannel(channelId) {
    const info = this.db.prepare("DELETE FROM channels WHERE channel_id = ?").run(channelId);
    if (info.changes) this.log.debug(`store remove ${channelId}`);
    return info.changes > 0;
  }

  //drop every channels belonging to server
  //used when bot is kicked or server is deleted
  removeServer(serverId) {
    const info = this.db.prepare("DELETE FROM channels WHERE server_id = ?").run(serverId);
    if (info.changes) this.log.debug(`store remove server ${serverId}`, { channels: info.changes });
    return info.changes;
  }

  // ==== relays: edit/delete tracking ====
  //
  // copy: { originId, authorName, serverId, serverName, destChannel, destId, showHeader }
  trackRelay(copy) {
    this.db
      .prepare(
        `INSERT INTO relays (origin_id, author_name, server_id, server_name, dest_channel, dest_id, show_header, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        copy.originId,
        copy.authorName || null,
        copy.serverId || null,
        copy.serverNamer || null,
        copy.destChannel,
        copy.destId,
        copy.showHeader ? 1 : 0,
        Date.now(),
      );
  }

  //all relayed copies of given origin message
  //each row carries origin metadata too (denormalized)
  //so an edit can rebuild header standalone
  copiesFor(originId) {
    return this.db
      .prepare(
        `SELECT author_name AS authorName, server_id AS serverId, server_name AS serverName, dest_channel AS destChannel, dest_id AS destId, show_header AS showHeader
         FROM relays WHERE origin_id = ?`,
      )
      .all(originId);
  }

  forgetOrigin(originId) {
    this.db.prepare("DELETE FROM relays WHERE origin_id = ?").run(originId);
  }

  //drop tracking rows older than TTL. returns how many sent
  pruneRelays(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    const info = this.db.prepare("DELETE FROM relays WHERE at < ?").run(cutoff);
    if (info.changes) this.log.trace(`pruned ${info.changes} relay row(s)`);
    return info.changes;
  }

  // ==== disk ====
  //
  // kept for call-site compatibility (shutdown path). WAL writes are
  // already durable, so this just checkpoints and is otherwise noop
  saveNow() {
    try {
      if (this.db) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      this.log.error("wal checkpoint failed", err);
    }
  }

  close() {
    if (this.db) this.db.close();
  }
}

module.exports = { Store };
