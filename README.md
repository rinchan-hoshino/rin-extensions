# Rin extensions

Experimental first-party extensions for [Rin](https://github.com/rinchan-hoshino/rin), loaded through Pi's native package system. Interfaces may change while these extensions are validated against live Rin updates, TUI, and Chat Bridge sessions.

## Install

```bash
rin install https://github.com/rinchan-hoshino/rin-extensions
```

Both extensions are enabled by default. Run `/usage` after installation to verify Codex access. Individual resources can be disabled with Pi package settings.

## Extensions

### `codex-usage`

Registers `/usage` for TUI and Chat Bridge. It reads the refreshed `openai-codex` OAuth credential through Pi's model registry and reports only ChatGPT Codex quota windows, account, plan, and credits. Chat receives a Codex-only PNG card; terminal frontends receive a text fallback.

It does not collect token telemetry, query other providers, persist a usage database, or render token-history charts.

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
