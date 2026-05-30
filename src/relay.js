// ==== Relay ====
//
// Takes message from one synced channel and relays it to others through
// rate queue. All network sends go through ctx.queue so pacing and
// backoff are consistently applied
//
// Notes
// > loop prevention: ignore bots own messages to avoid relay loops
// > mention safety: mention markup is flattened to plain text before
//   relaying, preventing accidental cross-server pings

//nerimity encodes these inline. same markup librarys own toString()
//methods produce
// > [@:id] user    [#:id] channel    [q:id] quoted message     [r:id] role
const RE_USER = /\[@:(\d+)\]/g;
const RE_CHANNEL = /\[#:(\d+)\]/g;
const RE_QUOTE = /\[q:(\d+)\]/g;
const RE_ROLE = /\[r:(\d+)\]/g;

//flatten mention markup into plain text
function sanitizeMentions(content, client) {
  if (!content) return "";
  return content
    .replace(RE_USER, (_, id) => {
      const user = client.users.cache.get(id);
      return "@" + (user ? user.username : "someone");
    })
    .replace(RE_CHANNEL, (_, id) => {
      const channel = client.channels.cache.get(id);
      return "#" + (channel && channel.name ? channel.name : "channel");
    })
    .replace(RE_ROLE, "@role")
    .replace(RE_QUOTE, "")
    .trim();
}

//build text that gets send into other channels
//format is interntionally plain and easy to tweak
// > looks like: **username** • ServerName
// >             message body
function formatRelay(message, originServerName, client) {
  const username = message.user ? message.user.username : "unknown";
  const body = sanitizeMentions(message.content, client);

  //attachment relay not yet implemented
  const attachments = message.raw && message.raw.attachments;
  const attachmentNote =
    attachments && attachments.length
      ? `\n_(${attachments.length} attachment(s) not relayed)_`
      : "";

  const text = body || "_(no text content)_";
  return `**${username}** • ${originServerName}\n${text}${attachmentNote}`;
}

// ==== broadcast ====
//
// ctx: { client, queue, store, log, config }
// returns number of destination channels relay was queued for
function broadcast(ctx, message) {
  const { client, queue, store, log } = ctx;

  //skip own messages
  if (client.user && message.user && message.user.id === client.user.id) {
    log.trace("skip relay: own message");
    return 0;
  }

  //skip commands; handled elsewhere
  if (message.command) {
    log.trace("skip relay: command message");
    return 0;
  }

  //only relay if origin channel is part of network
  if (!store.hasChannel(message.channelId)) {
    log.trace("skip relay: origin channel not synced", {
      channel: message.channelId,
    });
    return 0;
  }

  const originServerName =
    (message.channel && message.channel.server && message.channel.server.name) || "a server";
  const text = formatRelay(message, originServerName, client);

  const targets = store.listChannels().filter((entry) => entry.channelId !== message.channelId);

  if (!targets.length) {
    log.debug("nothing to relay to (only one channel in network)");
    return 0;
  }

  log.info(`relaying from ${originServerName} to ${targets.length} channel(s)`, {
    author: message.user && message.user.username,
  });

  for (const target of targets) {
    const channel = client.channels.cache.get(target.channelId);
    if (!channel) {
      //in store but not cache? bot max have been removed from server. clean up to stop trying
      log.warn("target channel missing from cache, unlinking", {
        channel: target.channelId,
        server: target.serverName,
      });
      store.removeChannel(target.channelId);
      continue;
    }

    const label = `relay->${target.serverName || target.channelId}`;
    queue
      .enqueue(label, () => channel.send(text, { silent: true }))
      .catch((err) => {
        //already logged inside queue when it gave up
        //this catch just keeps rejection from becoming
        //an unhandled promise
        log.debug(`relay task failed for ${label}`, err);
      });
  }

  return targets.length;
}

module.exports = { broadcast, sanitizeMentions, formatRelay };
