# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An [OpenCode](https://opencode.ai) **TUI plugin** that renders a `Timing` panel into the session sidebar, showing per-session API/wall-clock timing derived purely from message timestamps. Published to npm as `@foae/opencode-timings`. Two source files: `src/timing.ts` (pure logic) and `src/tui.tsx` (the Solid component + slot registration).

## Commands

- `bun run typecheck` — `tsc --noEmit` over `src` and `test`.
- `bun test` — runs the unit tests in `test/` (Bun's built-in runner). A single file: `bun test test/timing.test.ts`; a single case: `bun test -t "<name substring>"`.
- `bun run prepublishOnly` — typecheck + test; the publish gate. Runs automatically on `npm/bun publish`.

There is **no build/bundle step**: the package ships raw `.tsx`/`.ts` from `src/` (see `files` + `exports` in `package.json`). OpenCode resolves `./tui` and runs the source directly under **Bun** at TUI startup. Runtime is Bun, not Node. Typecheck + tests are the local gates, but the only true end-to-end verification is loading the plugin in a running OpenCode TUI (`tui.json` plugin array) — that host environment can't be reproduced here.

## Architecture

Two files, deliberately split so the math is testable without the rendering runtime:

- **`src/timing.ts` — pure, JSX-free, unit-tested.** All metric computation (`computeTiming`), formatting (`fmtDuration`, `bar`, `sparkline`), row assembly (`buildRows`), and config parsing (`parseConfig`). It imports only a *type* from the SDK, so it loads under plain `bun test` with no opentui/Solid preload. Put new logic here, not in `tui.tsx`, and cover it in `test/timing.test.ts`.
- **`src/tui.tsx` — the Solid component + plugin registration.** Imports everything pure from `./timing.ts` and adds only the `SidebarTimingView` component, the event/timer wiring, and `api.slots.register`.

Key facts that aren't obvious from a single read:

- **SolidJS, not React.** `jsxImportSource` is `@opentui/solid` (set in both `tsconfig.json` and the `@jsxImportSource` pragma). Reactive values are *accessor functions* (`timing()`, `rows()`); elements are lowercase opentui intrinsics (`<box>`, `<text>`), not DOM. Lists use `<Index>`/`<For>`, not `.map()` (which recreates rather than reconciles). Plugin API types live in `node_modules/@opencode-ai/plugin/dist/tui.d.ts` — consult `TuiPluginApi` / `TuiState` / `TuiHostSlotMap` there.

- **Entry shape.** Default export is a `TuiPluginModule` (`{ id, tui }`). `tui(api, options)` calls `api.slots.register({ order, slots: { sidebar_content(...) } })`. `SIDEBAR_ORDER = 155` places it just below the built-in Quota panel (order 150) and above the variable-height MCP/LSP/Todo/Files sections.

- **Zero context-window pollution** is the core design constraint. The panel only *reads* session messages via `api.state.session.messages(sessionID)` and computes client-side. It must **never** inject into the message stream — preserve this when changing data sources.

- **Metrics (`computeTiming`).** Derived from `msg.time.created` / `msg.time.completed`:
  - `api` = sum of `completed − created` over completed **assistant** messages (inference time). Only counted when `dur > 0`, which also discards negative (clock-skew) and missing-`created` rows.
  - `wall` = span from earliest to latest timestamp across all messages (includes user read/think time).
  - `apiPct` is **clamped to 0–100**: summed per-turn inference over a single wall span can exceed 100% with overlapping/retried records or clock skew, so the percent and the gauge bar both clamp.
  - Also `turns`, `avg`, `slowest`, and a per-turn `durations` array for the sparkline.

- **Refresh model.** Event-driven via `api.event.on` for `message.updated`, `message.removed`, `session.updated`, `session.idle`. **The per-event property paths intentionally differ** — `message.updated`/`session.updated` carry a nested `info` object (`info.sessionID` / `info.id`, no top-level `sessionID`), while `message.removed`/`session.idle` carry `sessionID` directly. This matches the SDK event types; do **not** "standardize" them to `properties.sessionID` (it's `undefined` for two of the four and silently breaks refresh). A `createEffect` on `props.sessionID` re-reads on session switch and re-arms the async-hydration recovery `setTimeout`s (400/1500/4000ms) per session; a 15s `setInterval` is a low-frequency backstop. `read()` is wrapped in try/catch (returns `EMPTY`) because `api.state` can throw mid-read if a session is torn down. All timers/listeners are torn down via `onCleanup`.

- **Config.** `parseConfig` reads the tuple-form options (`["@foae/opencode-timings", { mode, fields }]`): `mode` is `"fancy"` (default) or `"simple"`; `fields` toggles individual values (`ratio`, `api`, `wall`, `turns`, `avg`, `slow`, `sparkline`), all defaulting `true`. **Each field gates exactly one value** — `buildRows` packs related values (`api`/`wall`, `turns`/`avg`) onto shared lines with `packRow`, dropping each independently, so the field-to-value mapping stays clean. `ratio` is the `api/wall` gauge (bar + percent in fancy, percent only in simple); `sparkline` is fancy-only. `parseConfig` iterates `DEFAULT_FIELDS`, so adding a field there is enough to make it parseable. Unknown/malformed options fall back to defaults rather than throwing.

## Packaging

- **`@opentui/core`, `@opentui/solid`, `solid-js` are `peerDependencies`** (with `devDependencies` mirrors for typecheck/test). The plugin's JSX is *created* by its opentui and *rendered* by the host's, so they must be the same instance — OpenCode provides them. Keep the peer ranges aligned with the host: `@opencode-ai/plugin@1.15.x` peer-requires `@opentui/* >= 0.2.16`. Do not move these to `dependencies` (forks the Solid/opentui runtime).
- `@opencode-ai/plugin` and `@opencode-ai/sdk` are **type-only** imports (erased at runtime) — they stay in dev/peer deps, never `dependencies`.

## Conventions

- Keep rendering robust to empty/partial state — every path must produce a valid panel (reading zeros) before the first turn. `EMPTY` is the canonical zero state.
- Every sidebar row is self-labeling (no bare numbers/glyphs). The header comment in `src/tui.tsx`, the metric doc in `src/timing.ts`, and the README's Metrics table must stay in sync with rendered output — update all when changing rows.
