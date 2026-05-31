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
const RE_USER = /\[@:(\d+|[es])\]/g;
const RE_CHANNEL = /\[#:(\d+)\]/g;
const RE_QUOTE = /\[q:(\d+)\]/g;
const RE_ROLE = /\[r:(\d+)\]/g;
const RE_COMMAND = /^\/[^:\s]*:\d+( .*)?$/m;

const knownBotIds = new Set();
const RE_COMMAND_TARGET = /^\/[^:\s]*:(\d+)/gm;

function noteCommandBots(content) {
  if (!content) return;
  for (const match of content.matchAll(RE_COMMAND_TARGET)) {
    knownBotIds.add(match[1]);
  }
}

function isKnownBot(id) {
  return knownBotIds.has(id);
}

//grouping state
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const lastAuthorByChannel = new Map();

// ==== edit/delete tracking =====
//
//
// tracks relayed copies for each source message so edits and deletes can be
// mirrored. entries expire after a TTL since old messages rarely change and
// the library only emits updates for cached messages
// > shape: originMessageId -> { at, originServerName, copies [{ message, showHeader }] }
const RELAY_TTL_MS = 60 * 60 * 1000;
const MAX_TRACKED = 2000;
const relayedByOrigin = new Map();

function pruneTracked() {
  const cutoff = Date.now() - RELAY_TTL_MS;
  for (const [id, entry] of relayedByOrigin) {
    if (entry.at < cutoff) relayedByOrigin.delete(id);
  }
  //hard cap as backstop
  //first key == oldest tracked origin
  while (relayedByOrigin.size > MAX_TRACKED) {
    relayedByOrigin.delete(relayedByOrigin.keys().next().value);
  }
}

function trackRelay(originId, originServerName, sentMessage, showHeader) {
  let entry = relayedByOrigin.get(originId);
  if (!entry) {
    entry = { at: Date.now(), originServerName, copies: [] };
    relayedByOrigin.set(originId, entry);
  }
  entry.copies.push({ message: sentMessage, showHeader });
}

//re-apply edits to all relayed copies, keeping their original header state
function propagateEdit(ctx, message) {
  const entry = relayedByOrigin.get(message.id);
  if (!entry) return;
  ctx.log.debug("propagate edit", { origin: message.id, copies: entry.copies.length });
  for (const copy of entry.copies) {
    const text = formatRelay(
      message,
      entry.originServerName,
      ctx.client,
      copy.showHeader,
      ctx.config.cdnUrl,
    );
    ctx.queue
      .enqueue(`edit->${copy.message.channelId}`, () => copy.message.edit(text))
      .catch(() => {});
  }
}

//delete all relayed copies of a deleted message, then forget
function propagateDelete(ctx, originId) {
  const entry = relayedByOrigin.get(originId);
  if (!entry) return;
  ctx.log.debug("propogate delete", { origin: originId, copies: entry.copies.length });
  for (const copy of entry.copies) {
    ctx.queue
      .enqueue(`delete->${copy.message.channelId}`, () => copy.message.delete())
      .catch(() => {});
  }
  relayedByOrigin.delete(originId);
}

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
      if (id === "e") return "(at)everyone";
      if (id === "s") return "(at)someone";
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
      const snip = snippet(sanitizeMentions(q.content, client), 80);
      return who ? `quoted ${who}: \u201c${snip}\u201d` : `quoted: \u201c${snip}\u201d`;
    })
    .replace(/@everyone/gi, "(at)everyone")
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

//build embeddable URLs for messages attachments
//
// > local provider: cdnBase + path
// > google_drive provider: a drive.google.com/uc link built from fileId
function attachmentUrls(message, cdnUrl) {
  const attachments = message.raw && message.raw.attachments;
  if (!attachments || !attachments.length) return [];

  const urls = [];
  for (const att of attachments) {
    if (att.provider === "google_drive" && att.fileId) {
      urls.push(`https://drive.google.com/uc?id=${att.fileId}`);
    } else if (att.path) {
      urls.push(cdnUrl + att.path);
    }
  }
  return urls;
}

//per-server name color
//
//assign each server a stable header color derived from its id
//
//nerimity renders [#hex]text[#reset] as colored text
// > only hue varies; saturation and lightness are fixed (readability)
function hashHue(serverId) {
  let h = 0;
  const s = String(serverId);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function hslToHex(hue, sat, light) {
  const s = sat / 100;
  const l = light / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function serverColor(serverId) {
  return hslToHex(hashHue(serverId), 70, 65);
}

//wrap text in neris color markup. return text unchanged if no id
function colorize(text, serverId) {
  if (!serverId || serverId === "?") return text;
  return `[${serverColor(serverId)}]${text}[#reset]`;
}

//build text that gets send into other channels
//format is interntionally plain and easy to tweak
// > with header: **username** • ServerName
// >              (reply context if any)
// >              message body
// >              attachment url(s), each on its own line so they embed
// > grouped:     header dropped, rest unchanged
function formatRelay(message, originServerName, client, showHeader, cdnUrl) {
  const username = message.user ? message.user.username : "unknown";

  const quoteMap = new Map();
  const quoted = message.raw && message.raw.quotedMessages;
  if (quoted) {
    for (const q of quoted) if (q && q.id) quoteMap.set(q.id, q);
  }

  const body = sanitizeMentions(message.content, client, quoteMap);
  const replyContext = buildReplyContext(message, client);
  const attachmentLinks = attachmentUrls(message, cdnUrl);

  const originServerId =
    (message.channel && message.channel.server && message.channel.server.id) || "?";
  const serverLabel = colorize(originServerName, originServerId);
  const header = showHeader ? `**${username}** • ${serverLabel}\n` : "";

  const parts = [];
  if (replyContext) parts.push(replyContext);
  if (body) parts.push(body);
  //each url on its own line
  if (attachmentLinks.length) parts.push(attachmentLinks.join("\n"));
  if (!parts.length) parts.push("_(no text content)_");

  return `${header}${parts.join("\n")}`;
}

// ==== broadcast ====
//
// ctx: { client, queue, store, log, config }
// returns number of destination channels relay was queued for
function broadcast(ctx, message) {
  const { client, queue, store, log, config } = ctx;

  //skip own messages
  if (client.user && message.user && message.user.id === client.user.id) {
    log.trace("skip relay: own message");
    return 0;
  }

  //skip commands; handled elsewhere
  if (message.command || (message.content && RE_COMMAND.test(message.content))) {
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
  const originServerId =
    (message.channel && message.channel.server && message.channel.server.id) || "?";
  const groupKey = `${authorId}@{originServerId}`;

  pruneTracked(); //drop expired before adding new

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
    const last = lastAuthorByChannel.get(target.channelId);
    const now = Date.now();
    const showHeader = !last || last.key !== groupKey || now - last.at > GROUP_WINDOW_MS;
    lastAuthorByChannel.set(target.channelId, { groupKey, at: now });

    const text = formatRelay(message, originServerName, client, showHeader, config.cdnUrl);
    const label = `relay->${target.serverName || target.channelId}`;
    queue
      .enqueue(label, () => channel.send(text, { silent: true }))
      .then((sent) => {
        if (sent) trackRelay(message.id, originServerName, sent, showHeader);
      })
      .catch((err) => {
        //already logged inside queue when it gave up
        //this catch just keeps rejection from becoming
        //an unhandled promise
        log.debug(`relay task failed for ${label}`, err);
      });
  }

  return targets.length;
}

module.exports = {
  broadcast,
  sanitizeMentions,
  formatRelay,
  buildReplyContext,
  noteCommandBots,
  isKnownBot,
  propagateEdit,
  propagateDelete,
};
