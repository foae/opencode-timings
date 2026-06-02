import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import {
  bar,
  buildRows,
  computeTiming,
  DEFAULT_FIELDS,
  EMPTY,
  type Fields,
  fmtDuration,
  parseConfig,
  sparkline,
  SPARK_POINTS,
} from "../src/timing.ts"

// computeTiming only reads role + time.{created,completed}; build minimal
// message-shaped objects rather than full SDK Message instances.
const asst = (created: number | undefined, completed: number | undefined): Message =>
  ({ role: "assistant", time: { created, completed } }) as unknown as Message
const user = (created: number | undefined): Message =>
  ({ role: "user", time: { created } }) as unknown as Message

// All fields on, with optional per-test overrides — robust to future fields.
const fields = (overrides: Partial<Fields> = {}): Fields => ({ ...DEFAULT_FIELDS, ...overrides })
const NO_FIELDS: Fields = fields({
  ratio: false, api: false, wall: false, turns: false, avg: false, slow: false, sparkline: false,
})

describe("computeTiming", () => {
  test("empty input yields the empty timing", () => {
    expect(computeTiming([])).toEqual(EMPTY)
  })

  test("a session with no completed assistant turns yields empty", () => {
    expect(computeTiming([user(1000), asst(2000, undefined)])).toEqual(EMPTY)
  })

  test("a single turn computes api, wall, avg, slowest, and percent", () => {
    const t = computeTiming([user(1000), asst(2000, 5000)])
    expect(t.turns).toBe(1)
    expect(t.apiMs).toBe(3000)
    expect(t.wallMs).toBe(4000) // 5000 - 1000
    expect(t.avgMs).toBe(3000)
    expect(t.slowestMs).toBe(3000)
    expect(t.apiPct).toBe(75) // 3000/4000
    expect(t.durations).toEqual([3000])
  })

  test("multiple turns sum api, average, and track the slowest", () => {
    const t = computeTiming([asst(1000, 3000), asst(4000, 4500), asst(5000, 11000)])
    expect(t.turns).toBe(3)
    expect(t.apiMs).toBe(2000 + 500 + 6000)
    expect(t.slowestMs).toBe(6000)
    expect(t.avgMs).toBeCloseTo(8500 / 3)
    expect(t.durations).toEqual([2000, 500, 6000])
  })

  test("user messages extend wall-clock but are not counted as turns", () => {
    const t = computeTiming([asst(1000, 2000), user(10_000)])
    expect(t.turns).toBe(1)
    expect(t.apiMs).toBe(1000)
    expect(t.wallMs).toBe(9000) // 10000 - 1000
  })

  test("apiPct is clamped to 100 when summed turns overlap the wall span", () => {
    // Two overlapping 4s turns over a 5s wall span => 160% before clamping.
    const t = computeTiming([asst(1000, 5000), asst(2000, 6000)])
    expect(t.apiMs).toBe(8000)
    expect(t.wallMs).toBe(5000)
    expect(t.apiPct).toBe(100)
  })

  test("negative durations (completed before created) are ignored", () => {
    expect(computeTiming([asst(5000, 3000)])).toEqual(EMPTY)
  })

  test("an assistant turn with only a completed timestamp is not counted", () => {
    // created undefined => dur = completed - completed = 0, excluded; and with no
    // `created` anywhere, wall has no lower bound.
    expect(computeTiming([asst(undefined, 5000)])).toEqual(EMPTY)
  })
})

describe("fmtDuration", () => {
  test.each([
    [0, "0s"],
    [42_000, "42s"],
    [59_499, "59s"],
    [60_000, "1m00s"],
    [91_000, "1m31s"],
    [3_600_000, "1h00m"],
    [3_661_000, "1h01m"],
    [-5, "0s"],
    [Number.NaN, "0s"],
  ])("%d ms -> %s", (ms, expected) => {
    expect(fmtDuration(ms)).toBe(expected)
  })
})

describe("bar", () => {
  test("renders filled/empty blocks proportional to percent", () => {
    expect(bar(0, 8)).toBe("░░░░░░░░")
    expect(bar(100, 8)).toBe("████████")
    expect(bar(78, 8)).toBe("██████░░") // round(6.24) = 6 filled
    expect(bar(50, 8)).toBe("████░░░░")
  })

  test("clamps out-of-range and non-finite percents", () => {
    expect(bar(150, 8)).toBe("████████")
    expect(bar(-10, 8)).toBe("░░░░░░░░")
    expect(bar(Number.NaN, 8)).toBe("░░░░░░░░")
  })
})

describe("sparkline", () => {
  test("empty input renders nothing", () => {
    expect(sparkline([])).toBe("")
  })

  test("a max value renders the tallest level, zero the shortest", () => {
    expect(sparkline([5])).toBe("█")
    expect(sparkline([0])).toBe("▁")
  })

  test("keeps only the most recent SPARK_POINTS values", () => {
    const many = Array.from({ length: SPARK_POINTS + 5 }, (_, i) => i + 1)
    expect([...sparkline(many)]).toHaveLength(SPARK_POINTS)
  })
})

describe("buildRows", () => {
  const t = computeTiming([asst(1000, 3000), asst(4000, 4500)])

  test("fancy mode renders all enabled rows, each self-labeled", () => {
    const rows = buildRows(t, "fancy", fields())
    expect(rows[0]).toMatch(/^api\/wall [█░]+ \d+%$/) // gauge with bar
    expect(rows.some((r) => r.startsWith("api ") && r.includes("· wall "))).toBe(true)
    expect(rows.some((r) => r.startsWith("turns ") && r.includes("· avg "))).toBe(true)
    expect(rows.some((r) => r.startsWith("slowest "))).toBe(true)
    expect(rows.some((r) => r.startsWith("per-turn "))).toBe(true)
  })

  test("disabled fields drop their rows", () => {
    expect(buildRows(t, "fancy", NO_FIELDS)).toEqual([])
  })

  test("each field toggles exactly one value, dropping it from its shared line", () => {
    // api off, wall on: the times line carries wall only, no api, and no gauge.
    const wallOnly = buildRows(t, "fancy", fields({ ratio: false, api: false, turns: false, avg: false, slow: false, sparkline: false }))
    expect(wallOnly).toEqual([`wall ${fmtDuration(t.wallMs)}`])

    // wall off, api on: the times line carries api only — the gauge no longer
    // smuggles api in via a different field.
    const apiOnly = buildRows(t, "fancy", fields({ ratio: false, wall: false, turns: false, avg: false, slow: false, sparkline: false }))
    expect(apiOnly).toEqual([`api ${fmtDuration(t.apiMs)}`])

    // ratio on, everything else off: just the gauge.
    const ratioOnly = buildRows(t, "fancy", fields({ api: false, wall: false, turns: false, avg: false, slow: false, sparkline: false }))
    expect(ratioOnly).toHaveLength(1)
    expect(ratioOnly[0]).toMatch(/^api\/wall [█░]+ \d+%$/)
  })

  test("the sparkline row is omitted when there are no durations", () => {
    const rows = buildRows(EMPTY, "fancy", fields({ ratio: false, api: false, wall: false, turns: false, avg: false, slow: false }))
    expect(rows.some((r) => r.startsWith("per-turn "))).toBe(false)
  })

  test("simple mode mirrors fancy but drops the bar and the sparkline", () => {
    const rows = buildRows(t, "simple", fields())
    expect(rows[0]).toMatch(/^api\/wall \d+%$/) // ratio, no bar
    expect(rows.some((r) => /[█░]/.test(r))).toBe(false) // no gauge blocks anywhere
    expect(rows.some((r) => r.startsWith("api ") && r.includes("· wall "))).toBe(true)
    expect(rows.some((r) => r.startsWith("per-turn "))).toBe(false) // sparkline is fancy-only
  })
})

describe("parseConfig", () => {
  test("no options defaults to fancy with every field enabled", () => {
    expect(parseConfig(undefined)).toEqual({ mode: "fancy", fields: fields() })
  })

  test("mode 'simple' is honored; anything else falls back to fancy", () => {
    expect(parseConfig({ mode: "simple" }).mode).toBe("simple")
    expect(parseConfig({ mode: "facy" }).mode).toBe("fancy")
  })

  test("individual boolean fields override, others keep their default", () => {
    expect(parseConfig({ fields: { api: false } }).fields).toEqual(fields({ api: false }))
    expect(parseConfig({ fields: { ratio: false } }).fields).toEqual(fields({ ratio: false }))
  })

  test("non-boolean field values and non-object fields are ignored", () => {
    expect(parseConfig({ fields: { api: "no" } }).fields.api).toBe(true)
    expect(parseConfig({ fields: "x" }).fields).toEqual(parseConfig(undefined).fields)
  })
})
