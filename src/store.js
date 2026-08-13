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
        channel_id      TEXT PRIMARY KEY,
        server_id       TEXT,
        server_name     TEXT,
        added_by        TEXT,
        added_at        INTEGER,
        last_active_at  INTEGER,
        warned_at       INTEGER
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS relays (
        origin_id       TEXT NOT NULL,
        origin_channel  TEXT,
        author_name     TEXT,
        server_id       TEXT,
        server_name     TEXT,
        dest_channel    TEXT NOT NULL,
        dest_id         TEXT NOT NULL,
        show_header     INTEGER NOT NULL DEFAULT 1,
        at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relays_origin ON relays (origin_id);
      CREATE INDEX IF NOT EXISTS idx_relays_dest ON relays (dest_id);
      CREATE INDEX IF NOT EXISTS idx_relays_at ON relays (at);
      CREATE TABLE IF NOT EXISTS counters (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS server_settings (
        server_id  TEXT PRIMARY KEY,
        emoji      TEXT,
        updated_at INTEGER
      );
    `);

    this._migrateSchema();

    const count = this.db.prepare("SELECT COUNT(*) AS n FROM channels").get().n;
    this.log.info(`store ready, ${count} synced channel(s)`);
    return this;
  }

  // ==== schema migration ====
  //
  // add colums to tables that predate version
  // (only matters for upgrades)
  _migrateSchema() {
    const cols = this.db
      .prepare("PRAGMA table_info(relays)")
      .all()
      .map((c) => c.name);
    if (!cols.includes("origin_channel")) {
      this.db.exec("ALTER TABLE relays ADD COLUMN origin_channel TEXT");
      this.log.info("schema migrate: added relays.origin_channel");
    }

    const chCols = this.db
      .prepare("PRAGMA table_info(channels)")
      .all()
      .map((c) => c.name);
    if (!chCols.includes("last_active_at")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN last_active_at INTEGER");
      //added_at is not a stand-in for activity, it marks old channels as stale
      this.db
        .prepare("UPDATE channels SET last_active_at = ? WHERE last_active_at IS NULL")
        .run(Date.now());
      this.log.info("schema migrate: added channels.last_active_at");
    }
    if (!chCols.includes("warned_at")) {
      this.db.exec("ALTER TABLE channels ADD COLUMN warned_at INTEGER");
      this.log.info("schema migrate: added channels.warned_at");
    }
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
                added_by AS addedBy, added_at AS addedAt,
                last_active_at AS lastActiveAt, warned_at AS warnedAt
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
        `INSERT INTO channels (channel_id, server_id, server_name, added_by, added_at, last_active_at, warned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           server_id = excluded.server_id,
           server_name = excluded.server_name,
           added_by = excluded.added_by,
           added_at = excluded.added_at,
           last_active_at = excluded.last_active_at,
           warned_at = NULL`,
      )
      .run(
        entry.channelId,
        entry.serverId || null,
        entry.serverName || null,
        entry.addedBy || null,
        Date.now(),
        Date.now(),
        null,
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

  // ==== activity ====

  touchChannel(channelId, at) {
    this.db
      .prepare("UPDATE channels SET last_active_at = ?, warned_at = NULL WHERE channel_id = ?")
      .run(at || Date.now(), channelId);
  }

  //channels quiet since cutoff, oldest first
  listInactiveChannels(cutoff) {
    return this.db
      .prepare(
        `SELECT channel_id AS channelId, server_id AS serverId, server_name AS serverName,
                last_active_at AS lastActiveAt, warned_at AS warnedAt
         FROM channels
         WHERE COALESCE(last_active_at, added_at) IS NOT NULL
           AND COALESCE(last_active_at, added_at) < ?
         ORDER BY COALESCE(last_active_at, added_at) ASC`,
      )
      .all(cutoff);
  }

  markWarned(channelId) {
    this.db.prepare("UPDATE channels SET warned_at = ? WHERE channel_id = ?").run(Date.now(), channelId);
  }

  //shift every channels clock forward
  creditDowntime(byMs) {
    const now = Date.now();
    const info = this.db
      .prepare(
        `UPDATE channels SET
           last_active_at = MIN(?, COALESCE(last_active_at, added_at, 0) + ?),
           warned_at = CASE WHEN warned_at IS NULL THEN NULL ELSE MIN(?, warned_at + ?) END`,
      )
      .run(now, byMs, now, byMs);
    return info.changes;
  }

  // ==== meta ====
  //
  // small key/value ints
  setMeta(key, value) {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? row.value : null;
  }

  // ==== relays: edit/delete tracking ====
  //
  // copy: { originId, originChannel, authorName, serverId, serverName, destChannel, destId, showHeader }
  trackRelay(copy) {
    this.db
      .prepare(
        `INSERT INTO relays (origin_id, origin_channel,author_name, server_id, server_name, dest_channel, dest_id, show_header, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        copy.originId,
        copy.originChannel || null,
        copy.authorName || null,
        copy.serverId || null,
        copy.serverName || null,
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

  //given an origin message id, find relayed copy
  //used to point a relayed reply at right copy
  copyInChannel(originId, destChannel) {
    const row = this.db.prepare(
      "SELECT dest_id AS destId FROM relays WHERE origin_id = ? AND dest_channel = ? LIMIT 1",
    )
      .get(originId, destChannel)
    return row ? row.destId : null;
  }

  //reverse lookup: given a copy id, find what it was a
  //copy of and which channel original lives in
  relayByCopyId(destId) {
    return this.db
      .prepare(
        "SELECT origin_id AS originId, origin_channel AS originChannel FROM relays WHERE dest_id = ? LIMIT 1",
      )
      .get(destId);
  }

  // ==== server settings ====
  //
  // per-server header customization

  //set or clear a servers header emoji
  setServerEmoji(serverId, emoji) {
    if (emoji == null) {
      this.db.prepare("DELETE FROM server_settings WHERE server_id = ?").run(serverId);
      this.log.debug(`store clear emoji ${serverId}`);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO server_settings (server_id, emoji, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET emoji = excluded.emoji, updated_at = excluded.updated_at`,
      )
      .run(serverId, emoji, Date.now());
    this.log.debug(`store set emoji ${serverId}`, { emoji });
  }

  getServerEmoji(serverId) {
    if (!serverId) return null;
    const row = this.db
      .prepare("SELECT emoji FROM server_settings WHERE server_id = ?")
      .get(serverId);
    return row && row.emoji ? row.emoji : null;
  }

  //number of linked channels per server
  //used to detect join (0 > 1) and leave (1 > 0)
  serverChannelCount(serverId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM channels WHERE server_id = ?").get(serverId)
      .n;
  }

  //distinct servers represented in network
  countServers() {
    return this.db.prepare("SELECT COUNT(DISTINCT server_id) AS n FROM channels").get().n;
  }

  // ==== counters: persistent, all-time stats ====
  //
  // monotonic counters that survive retsrats and are not affected by relay-row
  // pruning
  // used for lifetime totals in /status
  bumpCounter(name, by) {
    this.db
      .prepare(
        `INSERT INTO counters (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
      )
      .run(name, by || 1);
  }

  getCounter(name) {
    const row = this.db.prepare("SELECT value FROM counters WHERE name = ?").get(name);
    return row ? row.value : 0;
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
