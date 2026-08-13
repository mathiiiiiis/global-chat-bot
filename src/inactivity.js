// ==== inactivity ====
//
// Unlinks inactive channels to avoid unnecessary storage and queue work
//
// > warn after GC_INACTIVE_WARN_DAYS
// > unlink after GC_INACTIVE_DAYS
// > messages reset inactivity
//
// boot downtime is excluded to prevent mass pruning after outages

const { clearGrouping, colorize } = require("./relay.js");
const { makeLogger } = require("./logger.js");

const log = makeLogger("inactive");

const HEARTBEAT_KEY = "heartbeat"

function days(ms) {
  return Math.floor(ms / 86400000);
}

function systemLine(body) {
  return `**System** • ${colorize("Global Chat", "system")}\n${body}`;
}

//post into channel through queue, ignore if gone
function notify(ctx, channelId, text) {
  const channel = ctx.client.channels.cache.get(channelId);
  if (!channel) return false;
  clearGrouping(channelId);
  ctx.queue
    .enqueue(`inactive->${channelId}`, () => channel.send(text, { silent: true }))
    .catch(() => { });
  return true;
}

// ==== downtime refund ====
//
// pushes inactivity timestamps past downtime
// only applies after a full sweep interval
function refundDowntime(ctx) {
  const { store, config } = ctx;
  const last = store.getMeta(HEARTBEAT_KEY);
  const now = Date.now();
  store.setMeta(HEARTBEAT_KEY, now);
  if (!last) return;

  const gap = now - last;
  if (gap <= config.pruneSweepMs * 2) return;

  const touched = store.creditDowntime(gap);
  log.info(`refunded ${days(gap)}d of downtime to ${touched} channel(s)`);
}

// ==== sweep ====
function sweep(ctx) {
  const { store, config } = ctx;
  const now = Date.now();
  store.setMeta(HEARTBEAT_KEY, now);

  //never prune last channel
  const total = store.listChannels().length;
  if (total <= 1) return;

  let warned = 0;
  let removed = 0;

  // ==== stage 2: remove ====
  for (const entry of store.listInactiveChannels(now - config.pruneAfterMs)) {
    if (total - removed <= 1) break;
    if (removed >= config.pruneMaxPerSweep) break;

    notify(
      ctx,
      entry.channelId,
      systemLine(
        `\u{1F44B} This channel has been quiet for ${days(config.pruneAfterMs)} days ` +
        `and was unlinked from Global Chat. Run /setup to reconnect ;)`
      )
    );

    store.removeChannel(entry.channelId);
    clearGrouping(entry.channelId);
    removed++;
    log.info("unlinked inactive channel", {
      channel: entry.channelId,
      server: entry.serverName,
      quietDays: days(now - (entry.lastActiveAt || 0)),
    });
  }

  // ==== stage 1: warn ====
  if (config.pruneWarnMs < config.pruneAfterMs) {
    const grace = days(config.pruneAfterMs - config.pruneWarnMs);
    for (const entry of store.listInactiveChannels(now - config.pruneWarnMs)) {
      if (entry.warnedAt) continue;
      const sent = notify(
        ctx,
        entry.channelId,
        systemLine(
          `\u{23F3} This channel has been quiet for ${days(config.pruneWarnMs)} days. ` +
          `It will be unlinked after another ${grace} days. Send a message to keep it linked.`
        ),
      );
      if (!sent) continue;
      store.markWarned(entry.channelId);
      warned++;
      log.debug("warned inactive channel", {
        channel: entry.channelId,
        server: entry.serverName,
      });
    }
  }

  if (removed) ctx.refreshPresence();
  if (warned || removed) log.info(`inactivity sweep: ${warned} warned, ${removed} unlinked`);
  else log.trace(`inactivity sweep: nothing to do`);
}

// ==== lifecycle ====
function startInactivitySweep(ctx) {
  const { config } = ctx;
  if (!config.prune) {
    log.info("inactivity pruning disabled");
    return () => { };
  }

  refundDowntime(ctx);
  log.info(
    `inactivity pruning on: warn at ${days(config.pruneWarnMs)}d, ` +
    `unlink at ${days(config.pruneAfterMs)}d, sweeping every ` +
    `${Math.round(config.pruneSweepMs / 60000)}min`,
  );

  const run = () => {
    try {
      sweep(ctx);
    } catch (err) {
      log.error("inactivity sweep threw", err);
    }
  };

  run();
  const timer = setInterval(run, config.pruneSweepMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startInactivitySweep, sweep };
