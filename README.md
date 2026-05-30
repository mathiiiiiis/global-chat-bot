# Nerimity Bot: Global Chat but Better

There is this bot called Global Chat (Globalyap) by [Joddabod](https://github.com/JoddabodScripts),
but it isn't that great. It get's rate limited a lot.

So I made it my task to actually make it good AND open-source.

Yea.

---

It's also meant to be **readable** - the point is that anyone can crack it open and
get a rough idea of how a global-chat bot is put together. The headline feature is a
proper **outbound queue** that paces and retries API calls, because Nerimity
rate-limits hard and a naive "send to every channel at once" relay falls over the
moment more than a couple of servers are connected.

Built on [`@nerimity/nerimity.js`](https://github.com/nerimity/nerimity.js).

## What it does

- Wire any channel into a shared network with one command.
- Every normal message in a linked channel is relayed to all the others.
- All outbound calls go through a single rate-aware queue: one call in flight at a
  time, a minimum gap between calls, exponential backoff with jitter, and reactive
  backoff that honours the server's retry hint when it sends one.
- Quotes and replies are carried across, and attachments/images are relayed by URL.
- Repeated messages from the same author collapse the header, the way the client
  groups native messages.
- Mentions are flattened to plain text before relaying, so a relay never pings a
  random stranger who happens to share an id.
- Other bots are ignored by default, and commands (aimed at any bot) are never
  relayed; so it will not echo-loop with other relay bots or remote-trigger them.
- A debug run with deep logging so you can actually trace what went wrong.

## Quick start

```bash
git clone https://github.com/mathiiiiiis/global-chat-bot
cd global-chat-bot
npm install

cp .env.example .env       # then edit .env and paste your bot token
npm run register           # one-off: pushes the slash commands to Nerimity
npm start                  # or: npm run debug   for the loud logs
```

You need a Nerimity bot token (create a bot in your account settings and copy its
token into `GC_TOKEN`). Needs Node 20.12+.

## Using it

Add the bot to a server, then in the channel you want to link:

```
/setup here          link the current channel
/setup #general      link a specific channel by name or with the picker
/unlink here         remove the current channel from the network
/status              show network size and queue health
/help                what the bot does and its commands
/links               source code and author links
```

Do `/setup` in two or more channels across different servers and they are now talking
to each other. By default only **server admins** can run setup/unlink (set
`GC_ALLOW_ANYONE=1` to loosen that).

## Configuration

Everything is environment variables, see `.env.example` for the full list. The ones
you are most likely to touch:

| Variable | Default | What it does |
| --- | --- | --- |
| `GC_TOKEN` | (required) | Your bot token |
| `GC_MIN_GAP_MS` | `350` | Minimum spacing between outbound API calls |
| `GC_MAX_ATTEMPTS` | `5` | Retries before a send is dropped |
| `GC_ALLOW_ANYONE` | `0` | `1` lets any member run setup |
| `GC_RELAY_BOTS` | `0` | `1` relays other bots too (causes echo loops - leave off) |
| `GC_IGNORE_USERS` | (empty) | Comma-separated user ids to drop entirely |
| `GC_REGISTER_ON_START` | `0` | `1` re-registers slash commands on every boot |
| `GC_LOG_LEVEL` | `info` | `error` `warn` `info` `debug` `trace` |
| `GC_CDN_URL` | `https://cdn.nerimity.com/` | CDN base for building attachment URLs |

For a self-hosted Nerimity instance, point `GC_API_URL`, `GC_WS_URL`, and `GC_CDN_URL`
at it.

## The debug run

When relays misbehave (and across enough servers, they eventually will), run:

```bash
npm run debug          # raises the log level to debug (overrides GC_LOG_LEVEL)
```

You get timestamped, scoped lines for every step; command parsing, each
enqueue/dequeue, spacing waits, every retry and backoff window, store writes, and any
send that gets dropped and why. Pipe it to a file or journald; colours switch off
automatically when the output is not a terminal.

## How it works

```
message in a linked channel
        |
        v
  index.js (message handler)
        |
   command? --yes--> commands.js  (/setup /unlink /status /help /links)
        |
        no
        v
   relay.js  -> sanitize mentions, carry quotes/replies/attachments,
        |       fan out to other linked channels
        v
   rateQueue.js  -> paced, retried, backed-off sends to the API
```

| File | Responsibility |
| --- | --- |
| `src/index.js` | Entrypoint, client setup, event wiring, shutdown |
| `src/rateQueue.js` | The queue: pacing, retries, backoff, backpressure |
| `src/relay.js` | Broadcast fan-out, mention/quote/attachment handling, header grouping |
| `src/commands.js` | `/setup`, `/unlink`, `/status`, `/help`, `/links` + permission checks |
| `src/store.js` | JSON persistence for the linked-channel set |
| `src/presence.js` | Sets the bot activity line from network size |
| `src/logger.js` | Leveled, scoped logger |
| `src/config.js` | All tunables, read from the environment |
| `src/registerCommands.js` | One-off slash-command registration |

The linked-channel set lives in `src/data/synced.json` (gitignored). It is a plain
JSON file on purpose - easy to inspect and back up. Swapping it for sqlite is a
contained change if you outgrow it.

## Known gaps / good first PRs

- **Permission checks** fall back to an owner-only check when role data is not cached.
  A fuller role-based check would be welcome.
- **One global network.** Multiple independent "rooms" would be a nice add.
- **`google_drive` attachments** are built but less tested than local CDN uploads.

## A note on being a good neighbour

Please don't use this to dodge moderation or spam other communities. A global chat is
only fun while everyone wants to be in it.

## License

MIT - see [LICENSE](./LICENSE).
