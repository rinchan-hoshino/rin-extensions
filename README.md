# Rin extensions

Experimental first-party extensions for [Rin](https://github.com/rinchan-hoshino/rin), loaded through Pi's native package system. Interfaces may change while these extensions are validated against live Rin updates, TUI, and Chat Bridge sessions.

## Install

```bash
rin install https://github.com/rinchan-hoshino/rin-extensions
```

Both extensions are enabled by default. Run `/usage` after installation to verify Codex access. Individual resources can be disabled with Pi package settings.

## Extensions

### `codex-usage`

Owns the complete usage feature set removed from Rin core, narrowed to `openai-codex` only:

- records Codex session, turn, message, tool, capability, token, cache, context, and cost events through Pi lifecycle hooks;
- persists events under `~/.rin/data/extensions/codex-usage/usage.db` and migrates only Codex rows from the retired core database;
- records official 5-hour and weekly `percent_left` snapshots and derives actual quota consumption from decreases within the same reset epoch;
- reports actual quota consumption by default through `rin usage ...`; `--tokens` keeps token/context diagnostics available;
- combines ChatGPT Codex account, plan, quota windows, resets, credits, and a 7-day actual-quota chart in the `/usage` PNG;
- retains token aggregate/event queries, dimensions, filters, ordering, JSON, and all-time or day windows as secondary diagnostics;
- uses the same data as a terminal text fallback.

The store rejects non-Codex providers. Anthropic, Google, and Copilot probes are intentionally absent.

Examples:

```bash
rin usage --days 7
rin usage --tokens --days 7 --group-by provider_model
rin usage --events --filter event_type=message_end --limit 20
rin usage --all-time --json
rin usage --list-dimensions
```

### `self-improve-reminder`

Observes authoritative Rin self-improve distillation turns and sends each settled result once through the Rin Agent SDK. The extension is inert until a destination is configured outside the package.

Create `~/.rin/data/extensions/self-improve-reminder/config.json`:

```json
{
  "chatKey": "discord/<bot-id>:<channel-id>"
}
```

Optional `stateDir` can relocate the delivery ledger and idempotency claims. The default is `~/.rin/self_improve/state/self-improve-reminder`.

Environment overrides:

- `RIN_SELF_IMPROVE_REMINDER_CHAT_KEY`
- `RIN_SELF_IMPROVE_REMINDER_CONFIG`
- `RIN_DIR` or `PI_CODING_AGENT_DIR` for the Rin/Pi data directory

The package never contains deployment-specific chat IDs or credentials.

## Development

```bash
npm ci
npm run check
```
