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
const { broadcast } = require("./relay.js");
const { handleCommand } = require("./commands.js");

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

// ==== events ====
client.on(Events.Ready, () => {
  log.info(
    `connected as ${client.user ? client.user.username : "?"} ` +
      `(spacing ${config.minGapMs}ms, ${store.listChannels().length} channel(s) linked)`,
  );
});

client.on(Events.MessageCreate, (message) => {
  try {
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
  if (removed) log.info(`left "${server.name}", unlinked ${removed} channel(s)`);
});

client.on(Events.ServerChannelDeleted, (data) => {
  if (store.hasChannel(data.channelId)) {
    store.removeChannel(data.channelId);
    log.info("a linked channel was deleted, unlinked it", {
      channel: data.channelId,
    });
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
log.info("logging in...");
client.login(config.token);
