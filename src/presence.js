// ==== Presence ====
//
// sets bots activity line
//
// nerimtiy renders as "{action} {name}"

//fixed at boot so elapsed timer in client does not reset
//everytime text gets refreshed
const startedAt = Date.now();

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

//build activity object from current store state
function buildActivity(store) {
  const channels = store.listChannels();
  if (!channels.length) {
    return { action: "Waiting for", name: "/setup", startedAt };
  }
  const servers = new Set(channels.map((c) => c.serverId)).size;
  return {
    action: "Syncing",
    name: `${plural(channels.length, "channel")} in ${plural(servers, "server")}`,
    startedAt,
  };
}

//push current activity to nerimity
//safe to call before client is ready
function refreshPresence(ctx) {
  const user = ctx.client.user;
  if (!user || typeof user.setActivity !== "function") return;

  const activity = buildActivity(ctx.store);
  ctx.log.debug("presence ->", activity);
  try {
    user.setActivity(activity);
  } catch (err) {
    ctx.log.warn("failed to set presence", err);
  }
}

module.exports = { refreshPresence, buildActivity };
