/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createSignal, Show, onCleanup, createMemo } from "solid-js"

const PLUGIN_ID = "opencode-stats-for-nerds"

// ── Config ──

interface StatVisibility {
  tokens: boolean
  cache: boolean
  context: boolean
  cost: boolean
  genTime: boolean
  thinkTime: boolean
  ttft: boolean
  speed: boolean
  activity: boolean
  changes: boolean
  model: boolean
}

interface PluginOptions {
  show?: Partial<StatVisibility>
}

const DEFAULT_VISIBILITY: StatVisibility = {
  tokens: true,
  cache: true,
  context: true,
  cost: true,
  genTime: true,
  thinkTime: false,
  ttft: true,
  speed: true,
  activity: false,
  changes: true,
  model: true,
}

function resolveVisibility(options: unknown): StatVisibility {
  if (!options || typeof options !== "object") return { ...DEFAULT_VISIBILITY }
  const show = (options as PluginOptions).show
  if (!show || typeof show !== "object") return { ...DEFAULT_VISIBILITY }
  return { ...DEFAULT_VISIBILITY, ...show }
}

// ── Helpers ──

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}k`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtTps(n: number): string {
  if (n >= 100) return n.toFixed(0)
  if (n >= 10) return n.toFixed(1)
  return n.toFixed(2)
}

function fmtDuration(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

// ── Types ──

interface FlatPart {
  type: string
  time?: { start?: number; end?: number }
  tool?: string
  status?: string
}

interface RawMessage {
  id?: string
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

interface FileChange {
  file: string
  additions: number
  deletions: number
}

interface Stats {
  // token breakdown of current context (all last-turn snapshot)
  lastInput: number
  lastOutput: number
  lastThinking: number
  lastCached: number
  // context (last message)
  contextUsed: number
  contextLimit: number
  contextPercent: number
  // cost (cumulative)
  totalCost: number
  // timing (cumulative)
  activeTimeMs: number
  thinkTimeMs: number
  // timing (last-turn)
  lastTtft: number | null
  lastTps: number
  // activity (cumulative)
  stepCount: number
  toolCallCount: number
  // files
  fileChanges: FileChange[]
  totalAdditions: number
  totalDeletions: number
  // model
  model: string
  providerID: string
  turnCount: number
}

function findContextLimit(
  api: Parameters<TuiPlugin>[0],
  modelID: string | undefined,
  providerID: string | undefined,
): number {
  if (!modelID || !providerID) return 0
  const providers = api.state.provider
  const provider = providers.find((p: any) => p.id === providerID)
  if (!provider) return 0
  const model = (provider as any).models?.[modelID]
  if (!model) return 0
  return model.limit?.context || 0
}

function computeStats(
  messages: RawMessage[],
  sessionCost: number,
  fileChanges: FileChange[],
  contextLimit: number,
  partsByMessage: Map<string, FlatPart[]>,
): Stats | null {
  const assistants = messages.filter(
    (m) => m.role === "assistant" && m.tokens && (m.tokens.output || 0) > 0,
  )

  if (assistants.length === 0) return null

  let totalCost = 0
  let activeTimeMs = 0
  let thinkTimeMs = 0
  let stepCount = 0
  let toolCallCount = 0

  for (const m of assistants) {
    totalCost += m.cost || 0

    if (m.time?.created && m.time?.completed) {
      activeTimeMs += m.time.completed - m.time.created
    }

    // Parts are fetched separately via api.state.part(messageID)
    const parts = m.id ? partsByMessage.get(m.id) || [] : []
    for (const p of parts) {
      if (p.type === "step-start") stepCount++
      if (p.type === "tool") toolCallCount++
      if (p.type === "reasoning") {
        if (p.time?.start && p.time?.end) {
          thinkTimeMs += p.time.end - p.time.start
        }
      }
    }
  }

  // Context = last completed message's full token set
  const last = assistants[assistants.length - 1]
  const lastTk = last.tokens!
  const contextUsed =
    (lastTk.input || 0) + (lastTk.output || 0) + (lastTk.reasoning || 0) +
    (lastTk.cache?.read || 0) + (lastTk.cache?.write || 0)

  const contextPercent = contextLimit > 0 ? Math.round((contextUsed / contextLimit) * 100) : 0

  // TTFT — find first text or reasoning part's start time
  let lastTtft: number | null = null
  if (last.id && last.time?.created) {
    const lastParts = partsByMessage.get(last.id) || []
    for (const p of lastParts) {
      if ((p.type === "text" || p.type === "reasoning") && p.time?.start) {
        const delta = p.time.start - last.time.created
        if (delta > 0) {
          lastTtft = delta / 1000
          break
        }
      }
    }
  }

  // Speed
  let lastTps = 0
  if (last.time?.created && last.time?.completed) {
    const durSec = (last.time.completed - last.time.created) / 1000
    if (durSec > 0) {
      lastTps = (lastTk.output || 0) / durSec
    }
  }

  // Files
  let totalAdditions = 0
  let totalDeletions = 0
  for (const f of fileChanges) {
    totalAdditions += f.additions || 0
    totalDeletions += f.deletions || 0
  }

  // Last-turn cache (how much of current context is cached)
  const lastCached = (lastTk.cache?.read || 0) + (lastTk.cache?.write || 0)

  return {
    lastInput: lastTk.input || 0,
    lastOutput: lastTk.output || 0,
    lastThinking: lastTk.reasoning || 0,
    lastCached,
    contextUsed,
    contextLimit,
    contextPercent,
    totalCost: sessionCost || totalCost,
    activeTimeMs,
    thinkTimeMs,
    lastTtft,
    lastTps,
    stepCount,
    toolCallCount,
    fileChanges,
    totalAdditions,
    totalDeletions,
    model: last.modelID || "unknown",
    providerID: last.providerID || "",
    turnCount: assistants.length,
  }
}

// ── View ──

function StatsView(props: {
  api: Parameters<TuiPlugin>[0]
  sessionID: string
  visibility: StatVisibility
}) {
  const theme = () => props.api.theme.current
  const [collapsed, setCollapsed] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  const stop1 = props.api.event.on("message.updated", (e: any) => {
    if (e.properties?.sessionID !== props.sessionID) return
    setTick((v: number) => v + 1)
  })
  const stop2 = props.api.event.on("session.idle", (e: any) => {
    if (e.properties?.sessionID !== props.sessionID) return
    setTick((v: number) => v + 1)
  })
  const stop3 = props.api.event.on("message.part.updated", (e: any) => {
    if (e.properties?.sessionID !== props.sessionID) return
    setTick((v: number) => v + 1)
  })

  onCleanup(() => { stop1(); stop2(); stop3() })

  // Cache last good stats so sidebar doesn't blank out during generation
  let cached: Stats | null = null
  const isGenerating = createMemo(() => {
    tick()
    const msgs = props.api.state.session.messages(props.sessionID) as unknown as RawMessage[] || []
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant")
    if (!lastAssistant) return false
    const tk = lastAssistant.tokens
    return !tk || !tk.output
  })

  const stats = createMemo<Stats | null>(() => {
    tick()
    const msgs = props.api.state.session.messages(props.sessionID) as unknown as RawMessage[] || []
    const session = props.api.state.session.get(props.sessionID) as any

    let ctxLimit = 0
    const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && m.tokens)
    if (lastAssistant) {
      ctxLimit = findContextLimit(props.api, lastAssistant.modelID, lastAssistant.providerID)
    }

    const diff = props.api.state.session.diff(props.sessionID) as unknown as FileChange[] || []

    // Fetch parts for each assistant message via the separate API
    const partsByMessage = new Map<string, FlatPart[]>()
    for (const m of msgs) {
      if (m.role === "assistant" && m.id) {
        try {
          const parts = props.api.state.part(m.id) as unknown as FlatPart[]
          if (parts && parts.length > 0) {
            partsByMessage.set(m.id, parts)
          }
        } catch {
          // part() may not be available for all messages
        }
      }
    }

    const result = computeStats(msgs, session?.cost ?? 0, diff, ctxLimit, partsByMessage)
    if (result) cached = result
    return result
  })

  // Reactive view of stats — falls back to cached during generation
  const displayStats = createMemo<Stats | null>(() => {
    stats() // track
    if (cached) return cached
    return null
  })

  const v = props.visibility
  const t = () => theme()
  const L = "  " // label indent
  const GAP = "  " // gap between label and value

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <box flexDirection="row" gap={1} onMouseDown={() => setCollapsed((c: boolean) => !c)}>
        <text style={{ fg: t().textMuted }}>{collapsed() ? "\u25B6" : "\u25BC"}</text>
        <text style={{ fg: t().text, fontWeight: "bold" }}>Stats for Nerds</text>
        <Show when={isGenerating()}>
          <text style={{ fg: t().textMuted, fontStyle: "italic" }}>generating...</text>
        </Show>
      </box>

      <Show when={!collapsed()}>
        <Show
          when={displayStats()}
          fallback={<text style={{ fg: t().textMuted }}>{L + "waiting..."}</text>}
        >
          {(s) => (
            <box flexDirection="column">

              {/* ── Tokens — each on its own line to prevent wrapping ── */}
              <Show when={v.tokens}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Input" + GAP}</text>
                  <text style={{ fg: t().text }}>{fmt(s().lastInput)}</text>
                </box>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Output" + GAP}</text>
                  <text style={{ fg: t().text }}>{fmt(s().lastOutput)}</text>
                </box>
                <Show when={s().lastThinking > 0}>
                  <box flexDirection="row">
                    <text style={{ fg: t().textMuted }}>{L + "Thinking" + GAP}</text>
                    <text style={{ fg: t().text }}>{fmt(s().lastThinking)}</text>
                  </box>
                </Show>
              </Show>

              {/* ── Cache (merged read + write) ── */}
              <Show when={v.cache && s().lastCached > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Cached" + GAP}</text>
                  <text style={{ fg: t().text }}>{fmt(s().lastCached)}</text>
                </box>
              </Show>

              {/* ── Context ── */}
              <Show when={v.context && s().contextLimit > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Context" + GAP}</text>
                  <text
                    style={{
                      fg: s().contextPercent > 80 ? t().error
                        : s().contextPercent > 50 ? t().warning
                        : t().text,
                    }}
                  >
                    {fmt(s().contextUsed) + " / " + fmt(s().contextLimit)}
                  </text>
                  <text style={{ fg: t().textMuted }}>
                    {" (" + s().contextPercent + "%)"}
                  </text>
                </box>
              </Show>

              {/* ── Separator ── */}
              <text style={{ fg: t().textMuted }}>{L + "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              {/* ── Cost ── */}
              <Show when={v.cost}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Cost" + GAP}</text>
                  <text style={{ fg: t().text }}>{"$" + s().totalCost.toFixed(4)}</text>
                </box>
              </Show>

              {/* ── Gen Time ── */}
              <Show when={v.genTime && s().activeTimeMs > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Gen Time" + GAP}</text>
                  <text style={{ fg: t().text }}>{fmtDuration(s().activeTimeMs)}</text>
                </box>
              </Show>

              {/* ── Think Time ── */}
              <Show when={v.thinkTime && s().thinkTimeMs > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Think Time" + GAP}</text>
                  <text style={{ fg: t().text }}>{fmtDuration(s().thinkTimeMs)}</text>
                </box>
              </Show>

              {/* ── TTFT ── */}
              <Show when={v.ttft && s().lastTtft !== null}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "TTFT" + GAP}</text>
                  <text style={{ fg: t().text }}>{s().lastTtft!.toFixed(2) + "s"}</text>
                </box>
              </Show>

              {/* ── Speed ── */}
              <Show when={v.speed && s().lastTps > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Speed" + GAP}</text>
                  <text
                    style={{
                      fg: s().lastTps > 50 ? t().success
                        : s().lastTps > 15 ? t().warning
                        : t().textMuted,
                    }}
                  >
                    {fmtTps(s().lastTps) + " tok/s"}
                  </text>
                </box>
              </Show>

              {/* ── Separator ── */}
              <text style={{ fg: t().textMuted }}>{L + "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500"}</text>

              {/* ── Activity ── */}
              <Show when={v.activity && (s().stepCount > 0 || s().toolCallCount > 0)}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Activity" + GAP}</text>
                  <text style={{ fg: t().text }}>{s().stepCount + " steps"}</text>
                  <Show when={s().toolCallCount > 0}>
                    <text style={{ fg: t().textMuted }}>{" \u00B7 "}</text>
                    <text style={{ fg: t().text }}>{s().toolCallCount + " tools"}</text>
                  </Show>
                </box>
              </Show>

              {/* ── Changes ── */}
              <Show when={v.changes && s().fileChanges.length > 0}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Changes" + GAP}</text>
                  <text style={{ fg: t().success }}>{"+" + s().totalAdditions}</text>
                  <text style={{ fg: t().textMuted }}>{" "}</text>
                  <text style={{ fg: t().error }}>{"-" + s().totalDeletions}</text>
                  <text style={{ fg: t().textMuted }}>
                    {" \u00B7 " + s().fileChanges.length + " files"}
                  </text>
                </box>
              </Show>

              {/* ── Model ── */}
              <Show when={v.model}>
                <box flexDirection="row">
                  <text style={{ fg: t().textMuted }}>{L + "Model" + GAP}</text>
                  <text style={{ fg: t().textMuted }}>{s().model}</text>
                </box>
              </Show>

            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}

// ── Plugin ──

const tui: TuiPlugin = async (api, options) => {
  const visibility = resolveVisibility(options)

  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return (
          <StatsView
            api={api}
            sessionID={props.session_id}
            visibility={visibility}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
