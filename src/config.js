// ==== Config ====
//
// All tunables live here.
//
// There is a lot about timing here, this is
// because Nerimity rate-limits are "strict"
//
// > GC_TOKEN                   – required: Bot Token
// > GC_MIN_GAP_MS              - min spacing between outbound API calls
// > GC_WINDOW_LIMIT            – max sends per window (server allow 20/20s)
// > GC_WINDOW_MS               – window length in ms
// > GC_MAX_ATTEMPS             – how many times to retry sending
// > GC_BASE_BACKOFF            - first backoff step
// > GC_MAX_BACKOFF             – backoff ceiling
// > GC_QUEUE_MAX               – max queued tasks before shedding
// > GC_DATA_FILE               – where synced channels get persisted
// > GC_ALLOW_ANYONE            – "1" lets any member run /setup (default: admins only)
// > GC_ANNOUNCE                – "0" silences server join/leave announcements (default: on)
// > GC_INACTIVE_PRUNE          – "0" disables auto-unlinking
// > GC_INACTIVE_DAYS           – quiet days before channel is unlinked
// > GC_INACTIVE_WARN_DAYS      – quiet days before heads-up is posted
// > GC_INACTIVE_SWEEP_MIN      – how often sweep runs (in minutes)
// > GC_INACTIVE_MAX_PER_SWEEP  – unlink cap per sweep
// > GC_LOG_LEVEL               - error|warn|info|debug|trace (or --debug/--trace)
// > GC_API_URL                 – override api base (self-hosted/localhost testing)
// > GC_WS_URL                  – override websocket base (same)

const path = require("path");

try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch { }

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  //auth
  token: process.env.GC_TOKEN || "",

  //rate / queue
  minGapMs: num(process.env.GC_MIN_GAP_MS, 350),
  windowLimit: num(process.env.GC_WINDOW_LIMIT, 18),
  windowMs: num(process.env.GC_WINDOW_MS, 20000),
  maxAttempts: num(process.env.GC_MAX_ATTEMPTS, 5),
  baseBackoffMs: num(process.env.GC_BASE_BACKOFF, 1000),
  maxBackoffMs: num(process.env.GC_MAX_BACKOFF, 30000),
  queueMax: num(process.env.GC_QUEUE_MAX, 5000),

  //persistence
  dataFile: process.env.GC_DATA_FILE || path.join(__dirname, "data", "synced.json"),

  dbFile: process.env.GC_DB_FILE || path.join(__dirname, "data", "store.db"),

  //permissions
  //by default only server admins (or owner)
  //flip for casual/private instances
  allowAnyone: process.env.GC_ALLOW_ANYONE === "1",

  //register slash commands automatically on boot
  registerOnStart: process.env.GC_REGISTER_ON_START === "1",

  //relay messages from other bots
  relayBots: process.env.GC_RELAY_BOTS === "1",

  //system announce join/leave to all channels
  //enabled by default
  announce: process.env.GC_ANNOUNCE !== "0",

  //inactivity pruning
  //silent channels waste storage and slow fan out
  //GC_INACTIVE_PRUNE=0 disables pruning
  prune: process.env.GC_INACTIVE_PRUNE !== "0",
  pruneAfterMs: num(process.env.GC_INACTIVE_DAYS, 30) * 86400000,
  pruneWarnMs: num(process.env.GC_INACTIVE_WARN_DAYS, 23) * 86400000,
  pruneSweepMs: num(process.env.GC_INACTIVE_SWEEP_MIN, 60) * 60000,
  pruneMaxPerSweep: num(process.env.GC_INACTIVE_MAX_PER_SWEEP, 3),

  ignoredUsers: new Set(
    (process.env.GC_IGNORE_USERS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  ),

  //instance overrides
  //leave undefined for public nerimity.com instance
  apiUrl: process.env.GC_API_URL || undefined,
  wsUrl: process.env.GC_WS_URL || undefined,

  //CDN base used to build attachment URLs
  cdnUrl: (process.env.GC_CDN_URL || "https://cdn.nerimity.com/").replace(/\/?$/, "/"),
};

module.exports = config;
