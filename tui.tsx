/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show, onCleanup, createMemo, For } from "solid-js"

const PLUGIN_ID = "oc-stats-for-nerds"

// ── Helpers ──

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtCost(n: number): string {
  if (n === 0) return "$0.00"
  if (n < 0.01) return "$" + n.toFixed(4)
  return "$" + n.toFixed(2)
}

function fmtTps(n: number): string {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function fmtDur(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.floor(s % 60)}s`
}

function pad(str: string, width: number): string {
  const s = String(str)
  return s.length >= width ? s : s + " ".repeat(width - s.length)
}

// ── Stats computation ──

interface TurnStats {
  // last response stats
  lastInput: number
  lastOutput: number
  lastReasoning: number
  lastCacheRead: number
  lastCacheWrite: number
  lastContext: number
  lastCost: number
  lastModel: string
  lastDurationMs: number
  lastTps: number
  // session totals
  totalOutput: number
  totalCost: number
  turnCount: number
}

interface RawMessage {
  info: {
    role: string
    modelID?: string
    providerID?: string
    cost?: number
    tokens?: {
      total?: number
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number; write?: number }
    }
    time?: { created?: number; completed?: number }
  }
}

function computeTurnStats(messages: RawMessage[], sessionCost: number): TurnStats | null {
  const assistants = messages
    .filter((m) => m.info?.role === "assistant" && m.info?.tokens)
    .map((m) => m.info)

  if (assistants.length === 0) return null

  const last = assistants[assistants.length - 1]
  const tk = last.tokens!

  const lastContext =
    (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0) +
    (tk.cache?.read || 0) + (tk.cache?.write || 0)

  // Duration and TPS from timestamps
  let lastDurationMs = 0
  let lastTps = 0
  if (last.time?.created && last.time?.completed) {
    lastDurationMs = last.time.completed - last.time.created
    if (lastDurationMs > 0) {
      lastTps = (tk.output || 0) / (lastDurationMs / 1000)
    }
  }

  // Session totals
  let totalOutput = 0
  let totalCost = 0
  for (const m of assistants) {
    totalOutput += m.tokens?.output || 0
    totalCost += m.cost || 0
  }

  return {
    lastInput: tk.input || 0,
    lastOutput: tk.output || 0,
    lastReasoning: tk.reasoning || 0,
    lastCacheRead: tk.cache?.read || 0,
    lastCacheWrite: tk.cache?.write || 0,
    lastContext,
    lastCost: last.cost || 0,
    lastModel: last.modelID || "unknown",
    lastDurationMs,
    lastTps,
    totalOutput,
    totalCost: sessionCost || totalCost,
    turnCount: assistants.length,
  }
}

// ── View ──

function StatsView(props: { api: Parameters<TuiPlugin>[0]; sessionID: string }) {
  const theme = () => props.api.theme.current

  const [collapsed, setCollapsed] = createSignal(false)
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((v) => v + 1)

  // Event subscriptions
  const stop1 = props.api.event.on("message.updated", (e) => {
    if ((e.properties as any).sessionID !== props.sessionID) return
    bump()
  })
  const stop2 = props.api.event.on("message.part.updated", (e) => {
    if ((e.properties as any).sessionID !== props.sessionID) return
    bump()
  })
  const stop3 = props.api.event.on("session.idle", (e) => {
    const sid = (e.properties as any).id || (e.properties as any).sessionID
    if (sid !== props.sessionID) return
    bump()
  })

  onCleanup(() => { stop1(); stop2(); stop3() })

  const stats = createMemo<TurnStats | null>(() => {
    version() // track
    const msgs = props.api.state.session.messages(props.sessionID) as unknown as RawMessage[] || []
    const session = props.api.state.session.get(props.sessionID) as any
    return computeTurnStats(msgs, session?.cost ?? 0)
  })

  const toggle = () => setCollapsed((v) => !v)
  const t = () => theme()
  const labelW = 11

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      {/* Header — click to toggle */}
      <box
        flexDirection="row"
        gap={1}
        onMouseDown={() => setCollapsed((v) => !v)}
      >
        <text style={{ fg: t().textMuted }}>{collapsed() ? "\u25B6" : "\u25BC"}</text>
        <text style={{ fg: t().text }}>Token Stats</text>
      </box>

      <Show when={!collapsed()}>
        <Show
          when={stats()}
          fallback={
            <text style={{ fg: t().textMuted }}>{"  waiting for response..."}</text>
          }
        >
          {(s) => (
            <box flexDirection="column">
              {/* ── Last Response ── */}
              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Context", labelW)}</text>
                <text style={{ fg: t().text }}>{fmt(s().lastContext)}</text>
                <Show when={s().lastCacheRead > 0}>
                  <text style={{ fg: t().textMuted }}>{"  " + fmt(s().lastCacheRead) + " cached"}</text>
                </Show>
              </box>

              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Input", labelW)}</text>
                <text style={{ fg: t().text }}>{s().lastInput.toLocaleString()}</text>
              </box>

              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Output", labelW)}</text>
                <text style={{ fg: t().text }}>{s().lastOutput.toLocaleString()}</text>
              </box>

              <Show when={s().lastReasoning > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Thinking", labelW)}</text>
                  <text style={{ fg: t().text }}>{s().lastReasoning.toLocaleString()}</text>
                </box>
              </Show>

              {/* ── Separator ── */}
              <text style={{ fg: t().textMuted }}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              {/* ── Performance ── */}
              <Show when={s().lastDurationMs > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Duration", labelW)}</text>
                  <text style={{ fg: t().text }}>{fmtDur(s().lastDurationMs)}</text>
                </box>
              </Show>

              <Show when={s().lastTps > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{pad("  Speed", labelW)}</text>
                  <text
                    style={{
                      fg: s().lastTps > 50 ? t().success : s().lastTps > 15 ? t().warning : t().textMuted,
                    }}
                  >
                    {fmtTps(s().lastTps) + " tok/s"}
                  </text>
                </box>
              </Show>

              {/* ── Session ── */}
              <text style={{ fg: t().textMuted }}>{"  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Total out", labelW)}</text>
                <text style={{ fg: t().text }}>{s().totalOutput.toLocaleString()}</text>
              </box>

              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Total cost", labelW)}</text>
                <text style={{ fg: t().text }}>{fmtCost(s().totalCost)}</text>
              </box>

              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Turns", labelW)}</text>
                <text style={{ fg: t().text }}>{String(s().turnCount)}</text>
              </box>

              <box flexDirection="row">
                <text style={{ fg: t().textMuted }}>{pad("  Model", labelW)}</text>
                <text style={{ fg: t().textMuted }}>{s().lastModel}</text>
              </box>
            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}

// ── Plugin ──

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return <StatsView api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
