# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project aims to follow [Semantic Versioning](https://semver.org/). Everything so
far is pre-1.0, so the public API and config may still shift between minor
versions.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-05-30

Initial release. A from-scratch, open-source take on a Nerimity "Global Chat"
bot, built around a real outbound queue so it holds up under the platform's rate
limits instead of getting throttled to death.

### Added

Core relay

- Cross-server message relay: a message in one linked channel is fanned out to
  every other linked channel.
- `/setup <here|#channel>` to link a channel into the network, with target
  resolution for `here`, a `#name`, and the channel-picker `[#:id]` markup.
- `/unlink <here|#channel>` to remove a channel, and `/status` to show network
  size and queue health.
- Setup and unlink are admin-only by default (`GC_ALLOW_ANYONE=1` to loosen).

Rate handling

- Global rate-aware outbound queue: one request in flight at a time, a minimum
  gap between sends, exponential backoff with jitter, reactive backoff that
  honours the server's retry hint when present, and backpressure (sheds the
  oldest task past a cap rather than growing memory forever).
- All outbound calls (relays and command replies) go through the queue.

Message handling

- Mention sanitization: `[@:]`, `[#:]`, `[r:]`, `[q:]` markup is flattened to
  plain text before relaying, so a relay never pings a stranger across servers.
- Per-destination header grouping: consecutive messages from the same author
  drop the header line, matching how the client groups native messages.
- Quote and reply relaying: replies (from `message.replies`) are carried across
  as a blockquote, and inline quotes (from `message.raw.quotedMessages`) are
  rendered inline.
- Attachment and image relay by URL: local CDN attachments and Google Drive
  attachments are relayed as links, which Nerimity auto-embeds (no re-upload).

Presence and moderation

- Bot activity line ("Syncing N channels in M servers"), refreshed on boot and
  whenever the network size changes.
- `GC_IGNORE_USERS`: drop all messages and commands from specific user ids.
- Other bots are ignored by default to prevent relay-bot echo loops
  (`GC_RELAY_BOTS=1` to opt in).

Commands

- `/help` explains the bot and its commands.
- `/links` shows the source code and author links.

Operations

- Leveled, scoped logger with a debug run (`--debug` / `--trace` or
  `GC_LOG_LEVEL`) that traces command parsing, every queue movement, spacing
  waits, retries and backoff windows, and dropped sends.
- JSON-backed persistence for the linked-channel set, with atomic writes and a
  debounced save. Cleans up automatically when the bot leaves a server or a
  linked channel is deleted.
- Graceful shutdown on SIGINT/SIGTERM (flushes the store), plus safety nets that
  log and keep running on stray rejections instead of dying silently.
- All tuning via environment variables (token, pacing, retries, paths, instance
  overrides). Optionally loads a `.env` file at the project root.

Hosting

- Docker support: `Dockerfile` (Alpine, non-root user, dumb-init for clean
  signal handling), `docker-compose.yml`, and `.dockerignore`.
- Optional self-registration of slash commands on boot
  (`GC_REGISTER_ON_START=1`) so containers need no manual setup step.
- systemd unit under `deploy/` for bare-metal hosting.
- Configurable CDN base (`GC_CDN_URL`) and API/websocket overrides for
  self-hosted instances.

Project

- MIT license, README, `.env.example`, and the open-source scaffolding.

### Changed

- Module system declared as CommonJS (`"type": "commonjs"`) to match the
  library's examples and stop tooling from flagging it as ambiguous.
- Inline quotes render as `quoted: "..."` (label outside the quotes) rather than
  wrapping the author and text together.
- Minimum Node version raised to 20.12 (for `process.loadEnvFile`).
- Docker Compose uses environment-variable substitution instead of `env_file`,
  so the same file works from the CLI and from Portainer.

### Fixed

- `.env` files were not loaded automatically; the bot now reads one from the
  project root via `process.loadEnvFile`, with real environment variables still
  taking over when no file is present.
- Inline quotes were stripped to nothing instead of showing the quoted text.
- Reply-only messages (a reply with no body) relayed as "(no text content)";
  they now carry the reply context.
- Portainer deploys failed with "env file not found" because of the `env_file`
  directive; switched to variable substitution.
- Multi-bot echo loop: the bot relayed other relay bots (and their relays of its
  relays), stacking prefixes forever. Other bots are now ignored by default.

[Unreleased]: https://github.com/mathiiiiiis/global-chat-bot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mathiiiiiis/global-chat-bot/releases/tag/v0.1.0
