// ==== Entrypoint ====
//
// Wires everything together
// run it "with npm start", or "npm run debug" (or "node src/inde.js --debug")
// when needing more logs
//
// the flow:
// > a message lands -> if its a command handle it, otherwise relay it
//   to every other synced channel through the rate queue

const { Client, Events } = require("@nerimity/nerimity.js");

const config = require("./config.js");
const { makeLogger, setLevel } = require("./logger.js");
const { RateQueue } = require("./rateQueue.js");
const { Store } = require("./store.js");
const {
  broadcast,
  noteCommandBots,
  isKnownBot,
  propagateEdit,
  propagateEditRaw,
  propagateDelete,
  clearGrouping,
  announceNetwork,
} = require("./relay.js");
const { handleCommand, COMMAND_DEFS } = require("./commands.js");
const { refreshPresence } = require("./presence.js");

setLevel();
const log = makeLogger("bot");

//preflight
if (!config.token) {
  log.error("no token set. Put your token in GC_TOKEN (in .env) and try again!");
  process.exit(1);
}

// ==== build ====
const client = new Client({
  apiUrlOverride: config.apiUrl,
  wsUrlOverride: config.wsUrl,
});

const store = new Store(config.dbFile, log.child("store"), config.dataFile).load();

const queue = new RateQueue({
  logger: log.child("queue"),
  minGapMs: config.minGapMs,
  windowLimit: config.windowLimit,
  windowMs: config.windowMs,
  maxAttempts: config.maxAttempts,
  baseBackoffMs: config.baseBackoffMs,
  maxBackoffMs: config.maxBackoffMs,
  queueMax: config.queueMax,
});

//one context object passed into commands/relay so they share same client
const ctx = {
  client,
  store,
  queue,
  config,
  log: log.child("relay"),
};

//let command/relay trigger presence refresh
ctx.refreshPresence = () => refreshPresence(ctx);

// ==== events ====
client.on(Events.Ready, () => {
  log.info(
    `connected as ${client.user ? client.user.username : "?"} ` +
    `(spacing ${config.minGapMs}ms, budget ${config.windowLimit}/${config.windowMs / 1000}s, ` +
    `${store.listChannels().length} channel(s) linked)`,
  );
  ctx.refreshPresence();
});

client.on(Events.MessageCreate, (message) => {
  try {
    //learn bot ids from any command pattern in content
    noteCommandBots(message.content);

    //a foreign message in syncec channel interrupts author grouping there
    if (
      store.hasChannel(message.channelId) && !(client.user && message.user && message.user.id === client.user.id)
    ) {
      clearGrouping(message.channelId);
    }

    if (message.user) {
      if (config.ignoredUsers.has(message.user.id)) {
        log.debug("dropped message from ignored user", { user: message.user.id });
        return;
      }

      const member = message.member;
      const hasBotRole = member && member.roles.some((r) => r && r.botRole);
      const rawBot = message.raw && message.raw.createdBy && message.raw.createdBy.bot;
      const looksLikeBot = hasBotRole || rawBot || message.user.bot || isKnownBot(message.user.id);
      if (looksLikeBot && !config.relayBots) {
        log.debug("dropped message from bot", {
          user: message.user.id,
          name: message.user.username,
          via: hasBotRole ? "role" : rawBot ? "raw" : message.user.bot ? "cache" : "learned",
        });
        return;
      }
    }

    if (message.command) {
      handleCommand(ctx, message);
    } else {
      broadcast(ctx, message);
    }
  } catch (err) {
    //throw here must never kill socket listener
    log.error("message handler threw", err);
  }
});

//origin edited -> update relayed copies
//delivered only while origin still in libs cache
client.on(Events.MessageUpdate, (message) => {
  try {
    propagateEdit(ctx, message);
  } catch (err) {
    log.error("edit propagation threw", err);
  }
});

//raw socket fallback for edits by library, primarily for
//pre-restart relays. cached messages are skipped to avoid duplicate edits
client.socket.on("message:updated", (payload) => {
  try {
    if (!payload || !payload.messageId) return;
    if (client.messages.cache.has(payload.messageId)) return;
    propagateEditRaw(ctx, payload);
  } catch (err) {
    log.error("raw edit propagation threw", err);
  }
});

//origin deleted -> delete relayed copies
client.on(Events.MessageDelete, (data) => {
  try {
    propagateDelete(ctx, data.messageId);
  } catch (err) {
    log.error("delete propagation threw", err);
  }
});

client.on(Events.ServerJoined, (server) => {
  log.info(`joined server "${server.name}"; run /setup to link a channel`);
});

client.on(Events.ServerLeft, (server) => {
  const removed = store.removeServer(server.id);
  if (removed) {
    log.info(`left "${server.name}", unlinked ${removed} channel(s)`);
    ctx.refreshPresence();
    announceNetwork(ctx, "leave", server.name, null);
  }
});

client.on(Events.ServerChannelDeleted, (data) => {
  if (store.hasChannel(data.channelId)) {
    //save server identity before removal
    const ch = client.channels.cache.get(data.channelId);
    const server = ch && ch.server;
    const serverId = server && server.id;
    const serverName = (server && server.name) || "a server";

    store.removeChannel(data.channelId);
    log.info("a linked channel was deleted, unlinked it", {
      channel: data.channelId,
    });
    ctx.refreshPresence();

    if (serverId && store.serverChannelCount(serverId) === 0) {
      announceNetwork(ctx, "leave", serverName, null);
    }
  }
});

//safety nets
//
//log and keep going rather than dying on a stray rejection
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", reason);
});
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", err);
});

//shutdown
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`got ${signal}, flushing store and exiting`);
  store.saveNow();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

//go
async function start() {
  if (config.registerOnStart) {
    try {
      await client.updateCommands(config.token, COMMAND_DEFS);
      log.info(`registering ${COMMAND_DEFS.length} command(s) on start`);
    } catch (err) {
      log.error("command registration on start failed, continuing", err);
    }
  }
  log.info("logging in...");
  client.login(config.token);
}

start();
