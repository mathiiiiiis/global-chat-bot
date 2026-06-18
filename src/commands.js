// ==== Commands ====
//
// Handles slash commands
//
// > /setup [here | #channel]   – add a channel
// > /unlink [here | #channel]  – remove a channel
// > /status                    – show network status
//
// Commands arrive as messages. Library parses them into
// message.command = { name, args }, where args contains command arguments
// Examples:
// > "/setup here"    -> ["here"]
// > channel picker   -> ["[#:123]"]

const { RolePermissions } = require("@nerimity/nerimity.js");

//channel-picker markup eg [#:1234...]
const RE_CHANNEL_MENTION = /^\[#:(\d+)\]$/;

//nerimity custom emojis [ce:id:name] (anim: [ace:id:name])
//kept verbatim for consistent rendering
const RE_CUSTOM_EMOJI = /\[a?ce:[^\]]+\]/;

//extracts single emoji from /setemoji args
//accepts custom or unincode, rejects text
function extractEmoji(arg) {
  const custom = arg.match(RE_CUSTOM_EMOJI);
  if (custom) return custom[0];
  const trimmed = arg.trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.length > 16) return null;
  //require at least one non-ascii codepoint
  if (!/[^\x00-\x7F]/.test(trimmed)) return null;
  return trimmed;
}

//replay helper
//
//route replies through queue too, so even own confirmations respect
//rate limit. fire-and-forget; failures are logged by queue
function reply(ctx, message, text) {
  ctx.queue
    .enqueue(`reply:${message.command ? message.command.name : "?"}`, () => message.reply(text))
    .catch(() => { });
}

//permissions check
//
//returns true if user is allowed to change network wiring here
// > allowAnyone config bypasses check entirely
// > otherwise: server admins (hasPermission cover owner) may proceed
// > fall back to plain owner check if member/roles are not cached yet
function canManage(ctx, message) {
  if (ctx.config.allowAnyone) return true;

  const server = message.channel && message.channel.server;
  if (!server) return false;

  const member = message.member;
  if (member && typeof member.hasPermission === "function") {
    try {
      if (member.hasPermission(RolePermissions.ADMIN)) return true;
    } catch (err) {
      ctx.log.debug("hasPermission threw, falling back to owner check", err);
    }
  }
  return server.createdById === message.user.id;
}

//target resolution
//
//work out which channel a command refers to
//returns { ok, channelId, channel } or { ok: false, error }
function resolveTarget(ctx, message) {
  const server = message.channel && message.channel.server;
  if (!server) {
    return { ok: false, error: "This command only works inside a server." };
  }

  const arg = (message.command.args || []).join(" ").trim();

  //no arg or "here" > the channel command was run in
  if (!arg || arg.toLowerCase() === "here") {
    return { ok: true, channelId: message.channelId, channel: message.channel };
  }

  //channel-picker markup [#:id]
  const mention = arg.match(RE_CHANNEL_MENTION);
  if (mention) {
    const id = mention[1];
    const channel = ctx.client.channels.cache.get(id);
    if (!channel || !channel.server || channel.server.id !== server.id) {
      return { ok: false, error: "Channel is not in this server." };
    }
    return { ok: true, channelId: id, channel };
  }

  //plain "#name" or "name" > resolve by name within this server
  const wanted = arg.replace(/^#/, "").toLowerCase();
  const found = [...server.channels.values()].find(
    (ch) => ch.name && ch.name.toLowerCase() === wanted,
  );
  if (!found) {
    return { ok: false, error: `I searched far, but I could not find a channel called "${arg}".` };
  }
  return { ok: true, channelId: found.id, channel: found };
}

// ==== /setup ====
function handleSetup(ctx, message) {
  if (!canManage(ctx, message)) {
    ctx.log.info("seup denied (insufficiet permissions)", {
      user: message.user && message.user.username,
    });
    reply(ctx, message, "You need to be a server admin to set up Global Chat.");
    return;
  }

  const target = resolveTarget(ctx, message);
  if (!target.ok) {
    reply(ctx, message, target.error);
    return;
  }

  if (ctx.store.hasChannel(target.channelId)) {
    reply(ctx, message, "That channel is already part of Global Chat.");
    return;
  }

  const server = target.channel.server;
  ctx.store.addChannel({
    channelId: target.channelId,
    serverId: server.id,
    serverName: server.name,
    addedBy: message.user.id,
  });

  const total = ctx.store.listChannels().length;
  ctx.log.info("channel linked", {
    channel: target.channelId,
    server: server.name,
    total,
  });
  if (ctx.refreshPresence) ctx.refreshPresence();
  reply(
    ctx,
    message,
    `Linked ${target.channel.toString()} into Global Chat :D\n` +
    `The network now spans ${total} channel(s). Say hello!`,
  );
}

// ==== /unlink ====
function handleUnlink(ctx, message) {
  if (!canManage(ctx, message)) {
    reply(ctx, message, "You need to be a server admin to change Global Chat.");
    return;
  }

  const target = resolveTarget(ctx, message);
  if (!target.ok) {
    reply(ctx, message, target.error);
    return;
  }

  const removed = ctx.store.removeChannel(target.channelId);
  if (!removed) {
    reply(ctx, message, "That channel was not part of Global Chat.");
    return;
  }

  ctx.log.info("channel unlinked", { channel: target.channelId });
  if (ctx.refreshPresence) ctx.refreshPresence();
  reply(ctx, message, "Unlinked this channel from Global Chat.");
}

// ==== /setemoji ====
function handleSetemoji(ctx, message) {
  if (!canManage(ctx, message)) {
    reply(ctx, message, "Ask the server admin to set this up.");
    return;
  }

  const server = message.channel && message.channel.server;
  if (!server) {
    reply(ctx, message, "This only works in a server, dummy.");
    return;
  }

  const arg = (message.command.args || []).join(" ").trim();

  if (!arg || /^(clear|none|off|remove)$/i.test(arg)) {
    ctx.store.setServerEmoji(server.id, null);
    ctx.log.info("server emoji cleared", { server: server.name });
    reply(ctx, message, "Cleared this server's emoji");
    return;
  }

  const emoji = extractEmoji(arg);
  if (!emoji) {
    reply(
      ctx,
      message,
      "Please give me a single emoji, like `/setemoji \u{1F431}` or a custom server emoji. " +
      "Use `/setemoji clear` to remove it.",
    );
    return;
  }

  ctx.store.setServerEmoji(server.id, emoji);
  ctx.log.info("server emoji set", { server: server.name, emoji });
  reply(
    ctx,
    message,
    `Header emoji set to ${emoji} for this server. It will show on all messages relayed from here.`,
  );
}

// ==== /status ====
function handleStatus(ctx, message) {
  const linked = ctx.store.hasChannel(message.channelId);
  const total = ctx.store.listChannels().length;
  const allTime = ctx.store.getCounter("relayed");
  const q = ctx.queue.stats;

  reply(
    ctx,
    message,
    `Global Chat status:\n` +
    `> this channel: ${linked ? "linked" : "not linked"}\n` +
    `> channels in network: ${total}\n` +
    `> relayed: ${allTime} all-time (${q.done} this session)\n` +
    `> queue: ${ctx.queue.size} waiting, ${q.retried} retried, ${q.failed} failed`,
  );
}

//links
//
//used by /links refrenced from /help
const REPO_URL = "https://github.com/mathiiiiiis/global-chat-bot";
const AUTHOR_URL = "https://mathiiis.de";
const NERIMITY_SERVER_INVITE = "https://nerimity.com/i/fBctp";

// ==== /help ====
function handleHelp(ctx, message) {
  reply(
    ctx,
    message,
    `**Global chat** links channels across servers into one shared conversation.\n` +
    `\n` +
    `Commands:\n` +
    `> /setup <here|#channel> - link a channel into the network\n` +
    `> /unlink <here|#channel> - remove a channel from the network\n` +
    `> /setemoji <emoji|clear> – set this server's emoji (admin)`
      `> /status - show network and queue status\n` +
    `> /links - source code and author links\n` +
    `> /help - this message lol\n` +
    `\n` +
    `Run /setup in two or more channels across different servers and they are ` +
    `connected. Messages, replies, quotes, images, edits, and deletions all ` +
    `carry across. ` +
    `\n` +
    `Setup and unlink are admin-only.`,
  );
}

// ==== /links ====
function handleLinks(ctx, message) {
  reply(
    ctx,
    message,
    `**Global Chat - links**\n` +
    `> Source code: <${REPO_URL}>\n` +
    `> Author: <${AUTHOR_URL}>\n` +
    `> Server Invite: <${NERIMITY_SERVER_INVITE}>`,
  );
}

//dispatch
function handleCommand(ctx, message) {
  const name = message.command.name;
  ctx.log.debug(`command "${name}`, {
    user: message.user && message.user.username,
    args: message.command.args,
  });

  switch (name) {
    case "setup":
      return handleSetup(ctx, message);
    case "unlink":
      return handleUnlink(ctx, message);
    case "setemoji":
      return handleSetemoji(ctx, message);
    case "status":
      return handleStatus(ctx, message);
    case "help":
      return handleHelp(ctx, message);
    case "links":
      return handleLinks(ctx, message);
    default:
      ctx.log.trace(`ignoring unknown command "${name}`);
  }
}

//command definitions shared with registerCommands.js sso registered
//list and handled list never drift apart
const COMMAND_DEFS = [
  {
    name: "setup",
    description: "Link a channel into the Global Chat network.",
    args: "<here|#channel>",
  },
  {
    name: "unlink",
    description: "Remove a channel from the Global Chat network.",
    args: "<here|#channel>",
  },
  {
    name: "setemoji",
    description: "Set or clear this server's emoji.",
    args: "<emoji|clear>",
  },
  {
    name: "status",
    description: "Show Global Chat network and queue status.",
    args: "",
  },
  {
    name: "help",
    description: "Show what Global Chat does and its commands.",
    args: "",
  },
  {
    name: "links",
    description: "Get the source code and author links.",
    args: "",
  },
];

module.exports = { handleCommand, COMMAND_DEFS };
