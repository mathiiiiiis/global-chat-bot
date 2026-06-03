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

const { Message } = require("@nerimity/nerimity.js");

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
// tracking now lives in store (sqlite), so edits and deleted survive
// restart. no message content is kept, only teh copy ids plus header bits
// (author name, origin server). See store.js
//
// > TTL: rows older than this are pruned. editing an hours-old message is rare
const RELAY_TTL_MS = 60 * 60 * 1000;

function copyHandle(client, channelId, messageId) {
  const botId = client.user ? client.user.id : "";
  const raw = client.user && client.user.raw ? client.user.raw : { id: botId, username: "bot" };
  return new Message(client, {
    id: messageId,
    channelId,
    content: "",
    type: 0,
    createdAt: Date.now(),
    createdBy: raw,
  });
}

//re-apply edits to all relayed copies, keeping their original header state
function propagateEdit(ctx, message) {
  const copies = ctx.store.copiesFor(message.id);
  if (!copies.length) return;
  ctx.log.debug("propagate edit", { origin: message.id, copies: copies.length });
  for (const copy of copies) {
    const text = formatRelay(
      message,
      copy.serverName,
      ctx.client,
      Boolean(copy.showHeader),
      ctx.config.cdnUrl,
    );
    const handle = copyHandle(ctx.client, copy.destChannel, copy.destId);
    ctx.queue.enqueue(`edit->${copy.destChannel}`, () => handle.edit(text)).catch(() => {});
  }
}

function propagateEditRaw(ctx, payload) {
  const originId = payload && payload.messageId;
  const updated = (payload && payload.updated) || {};
  if (!originId || typeof updated.content !== "string") return;
  const copies = ctx.store.copiesFor(originId);
  if (!copies.length) return;
  ctx.log.debug("propagating edit (raw)", { origin: originId, copies: copies.length });
  const body = sanitizeMentions(updated.content, ctx.client);
  for (const copy of copies) {
    const header = copy.showHeader
      ? `**${copy.authorName || "unknown"}** • ${colorize(copy.serverName || "a server", copy.serverId)}\n`
      : "";
    const text = `${header}${body || "_(no text content)_"}`;
    const handle = copyHandle(ctx.client, copy.destChannel, copy.destId);
    ctx.queue.enqueue(`edit->${copy.destChannel}`, () => handle.edit(text)).catch(() => {});
  }
}

//delete all relayed copies of a deleted message, then forget
function propagateDelete(ctx, originId) {
  const copies = ctx.store.copiesFor(originId);
  if (!copies.length) return;
  ctx.log.debug("propogating delete", { origin: originId, copies: copies.length });
  for (const copy of copies) {
    const channel = ctx.client.channels.cache.get(copy.destChannel);
    if (!channel) continue;
    ctx.queue
      .enqueue(`delete->${copy.destChannel}`, () => channel.deleteMessage(copy.destId))
      .catch(() => {});
  }
  ctx.store.forgetOrigin(originId);
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
  const c = serverColor(serverId);
  const safe = String(text).replace(/[[\]]/g, "");
  return `[gradient: ${c}-${c} ${safe}]`;
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
  const groupKey = `${authorId}@${originServerId}`;

  store.pruneRelays(RELAY_TTL_MS); //drop expired before adding new

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
    lastAuthorByChannel.set(target.channelId, { key: groupKey, at: now });

    const text = formatRelay(message, originServerName, client, showHeader, config.cdnUrl);
    const label = `relay->${target.serverName || target.channelId}`;
    const destChannelId = target.channelId;
    queue
      .enqueue(label, () => channel.send(text, { silent: true }))
      .then((sent) => {
        if (sent) {
          store.trackRelay({
            originId: message.id,
            authorName: message.user ? message.user.username : "unknown",
            serverId: originServerId,
            serverName: originServerName,
            destChannel: destChannelId,
            destId: sent.id,
            showHeader,
          });
        }
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
  propagateEditRaw,
  propagateDelete,
};
