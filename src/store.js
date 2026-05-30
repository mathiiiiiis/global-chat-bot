// ==== store ====
//
// persists set of channels wired into global network
// for now this is a JSON file, as this is a demo/reference bot and
// a JSON file is easy to inspect, back up, and reason about
//
// IF you are using this bot for larger audiences swapping this module
// for sqlite is a contained change (keep method names and you are done)
//
// On-disk shape:
// > version    – schema version, for future migrations
// > channels   – map of channelId => { channelId, serverId, serverName
//                addedBy, addedAt }

const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 250;

class Store {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.log = logger;
    this.data = { version: SCHEMA_VERSION, channels: {} };
    this._saveTimer = null;
  }

  // ==== lifecycle ====
  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.data = {
        version: parsed.version || SCHEMA_VERSION,
        channels: parsed.channels || {},
      };
      this.log.info(`loaded ${Object.keys(this.data.channels).length} synced channel(s)`);
    } catch (err) {
      if (err.code === "ENOENT") {
        this.log.info("no existing data file, starting fresh");
        this._ensureDir();
      } else {
        //do no nuke a file that failed to be parsed
        //someone may want to recover it by hands
        //start empty in memory but leave disk alone
        this.log.error("failed to read data file, starting empty", err);
      }
    }
    return this;
  }

  _ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  // ==== reads ====
  listChannels() {
    return Object.values(this.data.channels);
  }

  listChannelIds() {
    return Object.keys(this.data.channels);
  }

  hasChannel(channelId) {
    return Boolean(this.data.channels[channelId]);
  }

  getChannel(channelId) {
    return this.data.channels[channelId];
  }

  // ==== writes ====
  // entry: { channelId, serverId, serverName, addedBy }
  addChannel(entry) {
    this.data.channels[entry.channelId] = {
      channelId: entry.channelId,
      serverId: entry.serverId,
      addedBy: entry.serverName,
      addedBy: entry.addedBy,
      addedAt: Date.now(),
    };
    this.log.debug(`store add ${entry.channelId}`, { server: entry.serverName });
    this._scheduleSave();
  }

  removeChannel(channelId) {
    if (!this.data.channels[channelId]) return false;
    delete this.data.channels[channelId];
    this.log.debug(`store remove ${channelId}`);
    this._scheduleSave();
    return true;
  }

  //drop every channel belonging to a server
  //used when bot is kicked or server goes away
  removeServer(serverId) {
    let removed = 0;
    for (const [id, ch] of Object.entries(this.data.channels)) {
      if (ch.serverId === serverId) {
        delete this.data.channels[id];
        removed++;
      }
    }
    if (removed) {
      this.log.debug(`store remove server $${serverId}`, { channels: removed });
      this._scheduleSave();
    }
    return removed;
  }

  // ==== disk ====
  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  //synchronous on purpose. it is also called from the shutdown path
  //where writes need to finish before process exits
  saveNow() {
    try {
      this._ensureDir();
      const tmp = this.filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
      this.log.trace("store flushed to disk");
    } catch (err) {
      this.log.error("failed to write data file", err);
    }
  }
}

module.exports = { Store };
