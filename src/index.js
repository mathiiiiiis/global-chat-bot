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
const { broadcast, noteCommandBots, isKnownBot } = require("./relay.js");
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

const store = new Store(config.dataFile, log.child("store")).load();

const queue = new RateQueue({
  logger: log.child("queue"),
  minGapMs: config.minGapMs,
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
      `(spacing ${config.minGapMs}ms, ${store.listChannels().length} channel(s) linked)`,
  );
  ctx.refreshPresence();
});

client.on(Events.MessageCreate, (message) => {
  try {
    log.debug("AUTHOR DUMP", {
      username: message.user && message.user.username,
      userId: message.user && message.user.id,
      userBot: message.user && message.user.bot,
      rawCreatedByBot: message.raw && message.raw.createdBy && message.raw.createdBy.bot,
      rawCreatedByKeys:
        message.raw && message.raw.createdBy ? Object.keys(message.raw.createdBy) : null,
      hasMember: !!message.member,
      roleIds: message.member && message.member.roleIds,
      roles:
        message.member && message.member.roles
          ? message.member.roles.map((r) => ({
              id: r && r.id,
              name: r && r.name,
              botRole: r && r.botRole,
            }))
          : null,
    });
    //learn bot ids from any command pattern in content
    noteCommandBots(message.content);

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

client.on(Events.ServerJoined, (server) => {
  log.info(`joined server "${server.name}"; run /setup to link a channel`);
});

client.on(Events.ServerLeft, (server) => {
  const removed = store.removeServer(server.id);
  if (removed) {
    log.info(`left "${server.name}", unlinked ${removed} channel(s)`);
    ctx.refreshPresence();
  }
});

client.on(Events.ServerChannelDeleted, (data) => {
  if (store.hasChannel(data.channelId)) {
    store.removeChannel(data.channelId);
    log.info("a linked channel was deleted, unlinked it", {
      channel: data.channelId,
    });
    ctx.refreshPresence();
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
