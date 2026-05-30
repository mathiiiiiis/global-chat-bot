// ==== Config ====
//
// All tunables live here.
//
// There is a lot about timing here, this is
// because Nerimity rate-limits are "strict"
//
// > GC_TOKEN         – required: Bot Token
// > GC_MIN_GAP_MS    - min spacing between outbound API calls
// > GC_MAX_ATTEMPS   – how many times to retry sending
// > GC_BASE_BACKOFF  - first backoff step
// > GC_MAX_BACKOFF   – backoff ceiling
// > GC_QUEUE_MAX     – max queued tasks before shedding
// > GC_DATA_FILE     – where synced channels get persisted
// > GC_ALLOW_ANYONE  – "1" lets any member urn /setup (default: admins only)
// > GC_LOG_LEVEL     - error|warn|info|debug|trace (or --debug/--trace)
// > GC_API_URL       – override api base (self-hosted/localhost testing)
// > GC_WS_URL        – override websocket base (same)

const { register } = require("module");
const path = require("path");

try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch {}

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const config = {
  //auth
  token: process.env.GC_TOKEN || "",

  //rate / queue
  minGapMs: num(process.env.GC_MIN_GAP_MS, 350),
  maxAttempts: num(process.env.GC_MAX_ATTEMPTS, 5),
  baseBackoffMs: num(process.env.GC_BASE_BACKOFF, 1000),
  maxBackoffMs: num(process.env.GC_MAX_BACKOFF, 30000),
  queueMax: num(process.env.GC_QUEUE_MAX, 5000),

  //persistence
  dataFile: process.env.GC_DATA_FILE || path.join(__dirname, "data", "synced.json"),

  //permissions
  //by default only server admins (or owner)
  //flip for casual/private instances
  allowAnyone: process.env.GC_ALLOW_ANYONE === "1",

  //register slash commands automatically on boot
  registerOnStart: process.env.GC_REGISTER_ON_START === "1",

  //instance overrides
  //leave undefined for public nerimity.com instance
  apiUrl: process.env.GC_API_URL || undefined,
  wsUrl: process.env.GC_WS_URL || undefined,

  //CDN base used to build attachment URLs
  cdnUrl: (process.env.GC_CDN_URL || "https://cdn.nerimity.com/").replace(/\?$/, "/"),
};

module.exports = config;
