// ==== register commands ====
//
// When COMMAND_DEFS get changed run this.
// YOU DO NOT need to run thsi every time the bot starts
//
// Usage:
// > GC_TOKEN=you token node src/registerCommands.js
// > or: npm run register (with GC_TOKEN in .env)

const { Client } = require("@nerimity/nerimity.js");
const config = require("./config.js");
const { makeLogger, setLevel } = require("./logger.js");
const { COMMAND_DEFS } = require("./commands.js");

setLevel();
const log = makeLogger("register");

if (!config.token) {
  log.error("no token set. Put your token in GC_TOKEN (in .env) and try again!");
  process.exit(1);
}

const client = new Client({
  apiUrlOverride: config.apiUrl,
  wsUrlOverride: config.wsUrl,
});

log.info(`registering ${COMMAND_DEFS.length} command(s)...`);

client
  .updateCommands(config.token, COMMAND_DEFS)
  .then((res) => {
    log.info("done", res);
    process.exit(0);
  })
  .catch((err) => {
    log.error("failed to register commands", err);
    process.exit(1);
  });
