/** @jsxImportSource @opentui/solid */
/**
 * opencode-timings — a TUI sidebar panel showing per-session timing.
 *
 * Renders into OpenCode's `sidebar_content` slot (alongside Quota / MCP / LSP /
 * Todo / Files), reading the session's messages straight from the reactive TUI
 * state. Nothing is injected into the message stream, so there is zero
 * context-window pollution.
 *
 * Metrics (per session):
 *   - API    total assistant inference time = sum of (time.completed - time.created)
 *            over every completed assistant message, with its share of wall-clock.
 *   - wall   span from the first to the last message timestamp (includes the time
 *            you spend reading/typing between turns).
 *   - turns  number of completed assistant messages, plus the average duration.
 *   - slow   the single slowest assistant message.
 *
 * Modelled on @slkiser/opencode-quota's sidebar plugin (the reference for the
 * sidebar_content slot mechanism on OpenCode 1.15.x).
 */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { Message } from "@opencode-ai/sdk/v2"
import { createSignal, onCleanup, Show } from "solid-js"

const id = "opencode-timings"

// Render just below Quota (order 150) and above the variable-height built-in
// sections (MCP/LSP/Todo/Files) so the panel stays near the top of the fold.
const SIDEBAR_ORDER = 155

// Wall-clock and API time are derived purely from message timestamps, so events
// drive updates; this interval is just a low-frequency backstop.
const REFRESH_INTERVAL_MS = 15_000

type Timing = {
  ok: boolean
  apiMs: number
  wallMs: number
  turns: number
  avgMs: number
  slowestMs: number
  apiPct: number
}

const EMPTY: Timing = { ok: false, apiMs: 0, wallMs: 0, turns: 0, avgMs: 0, slowestMs: 0, apiPct: 0 }

function computeTiming(messages: ReadonlyArray<Message>): Timing {
  let apiMs = 0
  let turns = 0
  let slowestMs = 0
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = 0

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
          turns += 1
          if (dur > slowestMs) slowestMs = dur
        }
      }
    }
  }

  if (turns === 0) return EMPTY
  const wallMs = minTs === Number.POSITIVE_INFINITY ? 0 : Math.max(0, maxTs - minTs)
  return {
    ok: true,
    apiMs,
    wallMs,
    turns,
    avgMs: apiMs / turns,
    slowestMs,
    apiPct: wallMs > 0 ? Math.round((apiMs / wallMs) * 100) : 0,
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

function SidebarTimingView(props: { api: TuiPluginApi; sessionID: string }) {
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

  const lines = (): string[] => {
    const t = timing()
    return [
      `API   ${fmtDuration(t.apiMs)}  ${t.apiPct}%`,
      `wall  ${fmtDuration(t.wallMs)}`,
      `turns ${t.turns} · avg ${fmtDuration(t.avgMs)}`,
      `slow  ${fmtDuration(t.slowestMs)}`,
    ]
  }

  return (
    <Show when={timing().ok}>
      <box gap={0}>
        <text fg={props.api.theme.current.text}>
          <b>Timing</b>
        </text>
        <box gap={0}>
          {lines().map((line) => (
            <text fg={props.api.theme.current.textMuted} wrapMode="none">
              {line || " "}
            </text>
          ))}
        </box>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: SIDEBAR_ORDER,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <SidebarTimingView api={api} sessionID={props.session_id} />
      },
    },
  })
}

const pluginModule: TuiPluginModule & { id: string } = { id, tui }

export default pluginModule
