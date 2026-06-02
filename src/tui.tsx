/** @jsxImportSource @opentui/solid */
/**
 * opencode-timings — a TUI sidebar panel showing per-session timing.
 *
 * Renders into OpenCode's `sidebar_content` slot (alongside Quota / MCP / LSP /
 * Todo / Files), reading the session's messages straight from the reactive TUI
 * state. Nothing is injected into the message stream, so there is zero
 * context-window pollution.
 *
 * Fancy layout — every value names itself, all rows in the muted tone:
 *
 *   Timing
 *   api/wall ███████░ 78%      gauge: how much of wall-clock was model inference
 *   api 31s · wall 40s          the two raw times behind that ratio
 *   turns 4 · avg 8s            completed assistant turns and their average
 *   slowest 19s                 the single slowest turn
 *   per-turn ▄█▂▂               sparkline of each recent turn's duration
 *
 * Metrics (per session):
 *   - api      total assistant inference time = sum of (time.completed - time.created)
 *              over every completed assistant message.
 *   - wall     span from the first to the last message timestamp (includes the time
 *              you spend reading/typing between turns), so api is a fraction of it.
 *   - api/wall api's share of wall-clock, as a bar gauge and percent.
 *   - turns    number of completed assistant messages, plus the average duration.
 *   - slowest  the single slowest assistant message.
 *   - per-turn sparkline of recent per-turn durations.
 *
 * Config — pass options via the tuple form in `tui.json`:
 *
 *   "plugin": [
 *     ["@foae/opencode-timings@latest", {
 *       "mode": "fancy",            // "fancy" (default) | "simple"
 *       "fields": {                  // every field defaults to true
 *         "api": true, "wall": true, "turns": true,
 *         "avg": true, "slow": true, "sparkline": true
 *       }
 *     }]
 *   ]
 *
 * "fancy" draws a bar gauge for the api/wall ratio and a sparkline of recent
 * turn durations; "simple" is plain labeled rows. The panel is always shown
 * (values read zero before the first turn).
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Message } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup } from "solid-js"

const id = "opencode-timings"

// Render just below Quota (order 150) and above the variable-height built-in
// sections (MCP/LSP/Todo/Files) so the panel stays near the top of the fold.
const SIDEBAR_ORDER = 155

// Wall-clock and API time are derived purely from message timestamps, so events
// drive updates; this interval is just a low-frequency backstop.
const REFRESH_INTERVAL_MS = 15_000

// Narrower than the simple-mode rows so the "api/wall" label + gauge + percent
// fit one sidebar line without wrapping.
const BAR_WIDTH = 8
const SPARK_POINTS = 12
const SPARK_LEVELS = "▁▂▃▄▅▆▇█"

type Mode = "fancy" | "simple"
type Fields = {
  api: boolean
  wall: boolean
  turns: boolean
  avg: boolean
  slow: boolean
  sparkline: boolean
}
const DEFAULT_FIELDS: Fields = { api: true, wall: true, turns: true, avg: true, slow: true, sparkline: true }

type Timing = {
  apiMs: number
  wallMs: number
  turns: number
  avgMs: number
  slowestMs: number
  apiPct: number
  durations: number[]
}
const EMPTY: Timing = { apiMs: 0, wallMs: 0, turns: 0, avgMs: 0, slowestMs: 0, apiPct: 0, durations: [] }

function computeTiming(messages: ReadonlyArray<Message>): Timing {
  let apiMs = 0
  let slowestMs = 0
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = 0
  const durations: number[] = []

  for (const msg of messages) {
    const created = msg.time?.created
    if (typeof created === "number") {
      if (created < minTs) minTs = created
      if (created > maxTs) maxTs = created
    }
    if (msg.role === "assistant") {
      const completed = msg.time?.completed
      if (typeof completed === "number") {
        if (completed > maxTs) maxTs = completed
        const dur = completed - (typeof created === "number" ? created : completed)
        if (dur > 0) {
          apiMs += dur
          durations.push(dur)
          if (dur > slowestMs) slowestMs = dur
        }
      }
    }
  }

  const turns = durations.length
  if (turns === 0) return EMPTY
  const wallMs = minTs === Number.POSITIVE_INFINITY ? 0 : Math.max(0, maxTs - minTs)
  return {
    apiMs,
    wallMs,
    turns,
    avgMs: apiMs / turns,
    slowestMs,
    apiPct: wallMs > 0 ? Math.round((apiMs / wallMs) * 100) : 0,
    durations,
  }
}

/** Compact, sidebar-friendly duration: "42s", "6m31s", "1h02m". */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m${String(totalSec % 60).padStart(2, "0")}s`
  const hours = Math.floor(totalMin / 60)
  return `${hours}h${String(totalMin % 60).padStart(2, "0")}m`
}

function bar(pct: number, width: number): string {
  const p = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0))
  const filled = Math.round((p / 100) * width)
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
}

function sparkline(values: number[]): string {
  if (values.length === 0) return ""
  const points = values.slice(-SPARK_POINTS)
  const max = Math.max(...points, 1)
  return points
    .map((v) => {
      const idx = Math.round((v / max) * (SPARK_LEVELS.length - 1))
      return SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.max(0, idx))]
    })
    .join("")
}

function turnsLine(t: Timing, fields: Fields): string {
  if (fields.turns && fields.avg) return `turns ${t.turns} · avg ${fmtDuration(t.avgMs)}`
  if (fields.turns) return `turns ${t.turns}`
  if (fields.avg) return `avg ${fmtDuration(t.avgMs)}`
  return ""
}

// Every row is a labeled string in the muted tone — no value relies on the
// reader inferring what an unlabeled number or glyph means.
function buildRows(t: Timing, mode: Mode, fields: Fields): string[] {
  const rows: string[] = []
  if (mode === "fancy") {
    if (fields.api) rows.push(`api/wall ${bar(t.apiPct, BAR_WIDTH)} ${t.apiPct}%`)
    if (fields.wall) rows.push(`api ${fmtDuration(t.apiMs)} · wall ${fmtDuration(t.wallMs)}`)
    const ta = turnsLine(t, fields)
    if (ta) rows.push(ta)
    if (fields.slow) rows.push(`slowest ${fmtDuration(t.slowestMs)}`)
    if (fields.sparkline) {
      const spark = sparkline(t.durations)
      if (spark) rows.push(`per-turn ${spark}`)
    }
  } else {
    if (fields.api) rows.push(`api ${fmtDuration(t.apiMs)} · ${t.apiPct}% of wall`)
    if (fields.wall) rows.push(`wall ${fmtDuration(t.wallMs)}`)
    const ta = turnsLine(t, fields)
    if (ta) rows.push(ta)
    if (fields.slow) rows.push(`slowest ${fmtDuration(t.slowestMs)}`)
  }
  return rows
}

function SidebarTimingView(props: {
  api: TuiPluginApi
  sessionID: string
  mode: Mode
  fields: Fields
}) {
  const read = (): Timing => computeTiming(props.api.state.session.messages(props.sessionID))
  const [timing, setTiming] = createSignal<Timing>(read())
  const refresh = () => setTiming(read())

  // TUI/session state can hydrate asynchronously after mount or a session
  // switch, so recompute a few times early to recover from empty first reads.
  const recovery = [setTimeout(refresh, 400), setTimeout(refresh, 1500), setTimeout(refresh, 4000)]
  const interval = setInterval(refresh, REFRESH_INTERVAL_MS)

  const unsubscribers = [
    props.api.event.on("message.updated", (event) => {
      if (event.properties?.info?.sessionID === props.sessionID) refresh()
    }),
    props.api.event.on("message.removed", (event) => {
      if (event.properties?.sessionID === props.sessionID) refresh()
    }),
    props.api.event.on("session.updated", (event) => {
      if (event.properties?.info?.id === props.sessionID) refresh()
    }),
    props.api.event.on("session.idle", (event) => {
      if (event.properties?.sessionID === props.sessionID) refresh()
    }),
  ]

  onCleanup(() => {
    for (const timer of recovery) clearTimeout(timer)
    clearInterval(interval)
    for (const unsubscribe of unsubscribers) unsubscribe()
  })

  const rows = (): string[] => buildRows(timing(), props.mode, props.fields)

  return (
    <box gap={0}>
      <text fg={props.api.theme.current.text}>
        <b>Timing</b>
      </text>
      <box gap={0}>
        {rows().map((row) => (
          <text fg={props.api.theme.current.textMuted} wrapMode="none">
            {row || " "}
          </text>
        ))}
      </box>
    </box>
  )
}

function parseConfig(options: Record<string, unknown> | undefined): { mode: Mode; fields: Fields } {
  const opts = options ?? {}
  const mode: Mode = opts.mode === "simple" ? "simple" : "fancy"
  const fields: Fields = { ...DEFAULT_FIELDS }
  const raw = opts.fields
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(DEFAULT_FIELDS) as (keyof Fields)[]) {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === "boolean") fields[key] = value
    }
  }
  return { mode, fields }
}

const tui: TuiPlugin = async (api, options) => {
  const { mode, fields } = parseConfig(options)
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <SidebarTimingView api={api} sessionID={props.session_id} mode={mode} fields={fields} />
      },
    },
  })
}

const pluginModule: TuiPluginModule & { id: string } = { id, tui }

export default pluginModule
