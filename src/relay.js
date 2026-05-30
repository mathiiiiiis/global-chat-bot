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
// > author grouping: if same authot posts again with no one else in between
//   (per destination channel), drop header line
// > qoutes and replies: nerimity jeeps these OUTSIDE content. replies live on
//   message.replies, inline qoutes live on message.raw.quotedMessage. pill both
//   back in as readable so a reply-only message is not relayed blank

//nerimity encodes these inline. same markup librarys own toString()
//methods produce
// > [@:id] user    [#:id] channel    [q:id] quoted message     [r:id] role
const RE_USER = /\[@:(\d+)\]/g;
const RE_CHANNEL = /\[#:(\d+)\]/g;
const RE_QUOTE = /\[q:(\d+)\]/g;
const RE_ROLE = /\[r:(\d+)\]/g;

//grouping state
const lastAuthorByChannel = new Map();

//collapse whitespace clip long text down to a snippet for
//quote/reply previews, so a relaywed quote does not drag a
//whole paragraph
function snippet(text, max) {
  const limit = max || 80;
  const flat = (text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit - 1).trimEnd() + "\u2026";
}

//flatten mention markup into plain text
//inline qoutes agiants qouteMap
function sanitizeMentions(content, client, quoteMap) {
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
    .replace(RE_QUOTE, (_, id) => {
      const q = quoteMap && quoteMap.get(id);
      if (!q) return "";
      const who = q.createdBy && q.createdBy.username;
      const snip = snippet(q.content, 80);
      return who ? `quoted: \u201c${who}: ${snip}\u201d` : `\u201c${snip}\u201d`;
    })
    .trim();
}

//build reply-context
function buildReplyContext(message, client) {
  if (!message.replies || !message.replies.size) return "";
  const lines = [];
  for (const replied of message.replies.values()) {
    const who = replied.user ? replied.user.username : "someone";
    lines.push(`> \u21aa ${who}: ${snippet(sanitizeMentions(replied.content, client), 100)}`);
  }
  return lines.join("\n");
}

//build text that gets send into other channels
//format is interntionally plain and easy to tweak
// > with header: **username** • ServerName
// >              (reply context if any)
// >              message body
// > grouped:     header dropped, reply context + body only
function formatRelay(message, originServerName, client, showHeader) {
  const username = message.user ? message.user.username : "unknown";

  const quoteMap = new Map();
  const quoted = message.raw && message.raw.quotedMessages;
  if (quoted) {
    for (const q of quoted) if (q && q.id) quoteMap.set(q.id, q);
  }

  const body = sanitizeMentions(message.content, client, quoteMap);
  const replyContext = buildReplyContext(message, client);

  //attachment relay not yet implemented
  //(planned: pass CDN url through)
  const attachments = message.raw && message.raw.attachments;
  const attachmentNote =
    attachments && attachments.length
      ? `\n_(${attachments.length} attachment(s) not relayed)_`
      : "";

  const header = showHeader ? `**${username}** • ${originServerName}\n` : "";

  const parts = [];
  if (replyContext) parts.push(replyContext);
  if (body) parts.push(body);
  if (!parts.length) parts.push("_(no text content)_");

  return `${header}${parts.join("\n")}${attachmentNote}`;
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

  const targets = store.listChannels().filter((entry) => entry.channelId !== message.channelId);

  if (!targets.length) {
    log.debug("nothing to relay to (only one channel in network)");
    return 0;
  }

  log.info(`relaying from ${originServerName} to ${targets.length} channel(s)`, {
    author: message.user && message.user.username,
  });

  const authorId = message.user ? message.user.id : "?";

  for (const target of targets) {
    const channel = client.channels.cache.get(target.channelId);
    if (!channel) {
      //in store but not cache? bot max have been removed from server. clean up to stop trying
      log.warn("target channel missing from cache, unlinking", {
        channel: target.channelId,
        server: target.serverName,
      });
      store.removeChannel(target.channelId);
      lastAuthorByChannel.delete(target.channelId);
      continue;
    }

    //header grouping decided PER destination channel
    const showHeader = lastAuthorByChannel.get(target.channelId) !== authorId;
    lastAuthorByChannel.set(target.channelId, authorId);

    const text = formatRelay(message, originServerName, client, showHeader);
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

module.exports = { broadcast, sanitizeMentions, formatRelay, buildReplyContext };
