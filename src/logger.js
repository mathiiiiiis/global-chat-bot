// ==== Logger ====
//
// The whole point of this is the debug runs
// Levels:
// > error  – only stuff that actually broke
// > warn   – recovarable weirdness (rate limits, retries, etc)
// > info   – normal lifecycle (ready, setup, broadcasts)
// > debug  – per-task queue movement, command parsing, store writes
// > trace  – everything including payloads
//
// level can be set with GC_LOG_LEVEL=debug or pass --debug / --trace on
// command line (see config.js)

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

// ==== ansi colors ====
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);

const LEVEL_TAG = {
  error: paint("31", "ERROR"),
  warn: paint("33", "WARN "),
  info: paint("36", "INFO "),
  debug: paint("35", "DEBUG"),
  trace: paint("90", "TRACE"),
};

let activeLevel = LEVELS.info;

//resolve active levvel once at startup
function resolveLevel(opts) {
  const fromOpts = opts && opts.level;
  const fromEnv = process.env.GC_LOG_LEVEL;
  const name = (fromOpts || fromEnv || "").toString().toLowerCase();

  if (name && name in LEVELS) return LEVELS[name];
  if (process.argv.includes("--trace")) return LEVELS.trace;
  if (process.argv.includes("--debug") || process.env.DEBUG) return LEVELS.debug;
  return LEVELS.info;
}

function setLevel(opts) {
  activeLevel = resolveLevel(opts);
}

function timestamp() {
  return new Date().toISOString();
}

//turn extra args into readable suffix
function formatExtra(extra) {
  if (!extra.length) return "";
  const parts = extra.map((item) => {
    if (item instanceof Error) return item.stack || item.message;
    if (typeof item === "object") {
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    }
    return String(item);
  });
  return " " + parts.join(" ");
}

//a logger is always scopes (queue, relay, setup, ...) so mutli-source lines
//stay greppable. logger.child("relay") gives a sub-scopes logger
function makeLogger(scope) {
  const write = (levelName, stream, message, extra) => {
    if (LEVELS[levelName] > activeLevel) return;
    const line =
      `${paint("90", timestamp())} ${LEVEL_TAG[levelName]} ` +
      `${paint("1", "[" + scope + "]")} ${message}${formatExtra(extra)}`;
    stream.write(line + "\n");
  };

  return {
    scope,
    error: (msg, ...extra) => write("error", process.stderr, msg, extra),
    warn: (msg, ...extra) => write("warn", process.stderr, msg, extra),
    info: (msg, ...extra) => write("info", process.stderr, msg, extra),
    debug: (msg, ...extra) => write("debug", process.stderr, msg, extra),
    trace: (msg, ...extra) => write("trace", process.stderr, msg, extra),
    child: (sub) => makeLogger(`${scope}:${sub}`),
  };
}

module.exports = { makeLogger, setLevel, LEVELS };
