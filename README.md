# opencode-timings

A tiny [OpenCode](https://opencode.ai) **TUI sidebar** plugin that shows
per-session timing — how much wall-clock the session has taken and how much of
that was actually spent waiting on the model.

It renders into the same right-hand sidebar as the Quota / MCP / LSP / Todo /
Files panels, reading the session's messages directly from the TUI's reactive
state. Nothing is ever injected into the message stream, so there is **zero
context-window pollution**.

```
Timing
 API   6m31s  54%
 wall  12m04s
 turns 18 · avg 21s
 slow  1m12s
```

## Metrics

| Row     | Meaning |
|---------|---------|
| `API`   | Total assistant inference time — the sum of `time.completed − time.created` over every completed assistant message — and its share of wall-clock. |
| `wall`  | Span from the first to the last message timestamp. Includes the time you spend reading/typing between turns, so `API` is always a fraction of it. |
| `turns` | Number of completed assistant messages, plus the average per-turn duration. |
| `slow`  | The single slowest assistant message. |

The panel is always shown; before the first turn its values read zero.

## Install

Add it to the `plugin` array of the **TUI** config that OpenCode loads
(`~/.config/opencode/tui.json` or `tui.jsonc`) — this is a TUI plugin, so it
belongs in `tui.json`, not `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["@foae/opencode-timings@latest"]
}
```

OpenCode installs the plugin and its dependencies with Bun at startup. Restart
OpenCode and open the session sidebar to see the `Timing` panel.

You can also pin a version, e.g. `@foae/opencode-timings@0.1.0`.

## Requirements

- OpenCode `1.15.x` or newer (uses the TUI slot plugin API).

## License

MIT — see [LICENSE](./LICENSE).
