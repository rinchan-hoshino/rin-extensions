# Rin extensions

Experimental first-party extensions for [Rin](https://github.com/rinchan-hoshino/rin), loaded through Pi's native package system. Interfaces may change while these extensions are validated against live Rin updates, TUI, and Chat Bridge sessions.

## Install

```bash
rin install https://github.com/rinchan-hoshino/rin-extensions
```

All extensions are enabled by default. Run `/usage` after installation to verify Codex access. Individual resources can be disabled with Pi package settings.

## Extensions

### `codex-usage`

Owns the complete usage feature set removed from Rin core, narrowed to `openai-codex` only:

- records Codex session, turn, message, tool, capability, token, cache, context, and cost events through Pi lifecycle hooks;
- persists events under `~/.rin/data/extensions/codex-usage/usage.db` and migrates only Codex rows from the retired core database;
- records official 5-hour and weekly `percent_left` snapshots and derives actual quota consumption from decreases within the same reset epoch;
- keeps bare `rin usage` as a compact Codex-style text status with 20-segment remaining bars and reset times, while Chat `/usage` returns the quota card with a dated, per-local-day 14-day USD-equivalent usage trend as a PNG and uses the same compact status as its text fallback;
- keeps actual processed token aggregates available through explicit report options, using Pi's authoritative `totalTokens` and the normalized input/output/cache-read/cache-write components;
- keeps official quota snapshots as status/history available with `rin usage --quota`, while token aggregate/event queries remain available with all dimensions and filters;
- is listed by `rin --help`, runs as `rin usage ...`, and documents its options through `rin usage --help`.

The store rejects non-Codex providers. Anthropic, Google, and Copilot probes are intentionally absent.

Examples:

```bash
rin usage --days 7 --group-by provider_model
rin usage --quota --days 7
rin usage --events --filter event_type=message_end --limit 20
rin usage --all-time --json
rin usage --list-dimensions
```

### `i18n`

Owns the optional `~/.rin/i18n.json` Chat Bridge presentation catalog that was removed from Rin core. It reads command acknowledgements and compaction notices, owns the working-frame list and its active-agent animation timer, and publishes only the current `workingText` through Rin's generic `rinChatPresentation` extension API. Rin core never selects or rotates frames. Missing or invalid values fall back to Rin's English defaults. `/reload` reapplies file changes without restarting the daemon.

Both nested JSON objects and the historical dotted keys remain accepted. The existing file location is unchanged, so extraction does not require a user-data migration.

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
