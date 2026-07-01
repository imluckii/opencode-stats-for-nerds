/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createEffect, createSignal, For, Show, onCleanup } from "solid-js"
import { aggregateStats, type AggregatedStats } from "./server"

// ── Types ──

type PluginOptions = {
  refreshMs?: number
}

interface SessionData {
  id: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  model?: { id: string }
  time?: { created?: number; updated?: number }
}
interface MessageInfo {
  role: string
  modelID?: string
  providerID?: string
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number }
  time?: { created?: number; completed?: number }
}

const id = "oc-stats-for-nerds"

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function tpsColor(tps: number, theme: TuiThemeCurrent) {
  if (tps > 50) return theme.success
  if (tps > 20) return theme.warning
  return theme.error
}

function computeFromMessages(
  messages: MessageInfo[],
  session: SessionData,
): AggregatedStats | null {
  const sessionMessages = messages.map((m) => ({ info: m, parts: [] }))
  const stats = aggregateStats(sessionMessages as any, session)
  if (stats.totalOutput === 0) return null
  return stats
}

function formatInline(s: AggregatedStats): string {
  const parts: string[] = []
  parts.push(`${s.tps.toFixed(0)} tok/s`)
  if (s.firstTokenSec !== null) parts.push(`TTFT ${s.firstTokenSec.toFixed(1)}s`)
  parts.push(`${fmt(s.totalInput)} in`)
  parts.push(`${fmt(s.totalOutput)} out`)
  if (s.cacheRead > 0) parts.push(`${fmt(s.cacheRead)} cached`)
  parts.push(`$${s.totalCost.toFixed(4)}`)
  return parts.join(" · ")
}

// ── Sidebar View Component ──

function SidebarView(props: {
  api: Parameters<TuiPlugin>[0]
  options: PluginOptions | undefined
  sessionID: string
}) {
  const [stats, setStats] = createSignal<AggregatedStats | null>(null)
  const [collapsed, setCollapsed] = createSignal(false)
  const theme = () => props.api.theme.current

  const compute = () => {
    const session = props.api.state.session.get(props.sessionID) as unknown as SessionData | undefined
    if (!session) return
    const messages = props.api.state.session.messages(props.sessionID) as unknown as MessageInfo[] | undefined
    if (!messages || messages.length === 0) return
    const s = computeFromMessages(messages, session)
    if (s) setStats(s)
  }

  createEffect(() => {
    props.sessionID
    compute()
  })

  const stopUpdated = props.api.event.on("message.updated", (event) => {
    if ((event.properties as { sessionID?: string }).sessionID !== props.sessionID) return
    compute()
  })

  const stopIdle = props.api.event.on("session.idle", (event) => {
    const sid = (event.properties as { id?: string }).id || (event.properties as { sessionID?: string }).sessionID
    if (sid !== props.sessionID) return
    compute()
    const s = stats()
    if (s) {
      props.api.ui.toast({
        message: formatInline(s),
        variant: "success",
        duration: 6000,
      })
    }
  })

  onCleanup(() => {
    stopUpdated()
    stopIdle()
  })

  const toggleCollapsed = () => setCollapsed((v) => !v)

  return (
    <box
      flexDirection="column"
      paddingBottom={1}
      paddingTop={1}
      onMouseDown={toggleCollapsed}
      onKeyDown={(event: any) => {
        if (event.name === "return" || event.name === "space") {
          event.preventDefault()
          toggleCollapsed()
        }
      }}
    >
      {/* Header */}
      <box flexDirection="row" gap={1}>
        <text style={{ fg: theme().textMuted }}>
          {collapsed() ? "▶" : "▼"}
        </text>
        <text style={{ fg: theme().text, fontWeight: "bold" }}>
          Stats for Nerds
        </text>
      </box>

      <Show when={!collapsed()} fallback={<box></box>}>
        <Show when={stats()} fallback={
          <text style={{ fg: theme().textMuted }}>  waiting for data…</text>
        }>
          {(s) => {
            const data = s()
            const totalTokens = data.totalInput + data.totalOutput + data.totalReasoning
            return (
              <box flexDirection="column">
                {/* TPS */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  ⚡</text>
                  <text style={{ fg: tpsColor(data.tps, theme()) }}>
                    {data.tps.toFixed(1)} tok/s
                  </text>
                </box>

                {/* TTFT */}
                <Show when={data.firstTokenSec !== null}>
                  <box flexDirection="row" gap={1}>
                    <text style={{ fg: theme().textMuted }}>  ⏱</text>
                    <text style={{ fg: theme().textMuted }}>
                      TTFT {data.firstTokenSec!.toFixed(1)}s
                    </text>
                  </box>
                </Show>

                {/* Tokens */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  📊</text>
                  <text style={{ fg: theme().text }}>
                    {fmt(totalTokens)} tokens
                  </text>
                </box>

                {/* Token breakdown */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>    </text>
                  <text style={{ fg: theme().textMuted }}>
                    {fmt(data.totalInput)} in · {fmt(data.totalOutput)} out
                  </text>
                </box>

                <Show when={data.cacheRead > 0}>
                  <box flexDirection="row" gap={1}>
                    <text style={{ fg: theme().textMuted }}>    </text>
                    <text style={{ fg: theme().textMuted }}>
                      {fmt(data.cacheRead)} cached
                    </text>
                  </box>
                </Show>

                {/* Cost */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  💰</text>
                  <text style={{ fg: theme().text }}>
                    ${data.totalCost.toFixed(4)}
                  </text>
                </box>

                {/* Model */}
                <box flexDirection="row" gap={1}>
                  <text style={{ fg: theme().textMuted }}>  🤖</text>
                  <text style={{ fg: theme().textMuted }}>{data.model}</text>
                </box>
              </box>
            )
          }}
        </Show>
      </Show>
    </box>
  )
}

// ── Plugin ──

const tui: TuiPlugin = async (api, options) => {
  api.slots.register({
    order: 200,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return (
          <SidebarView
            api={api}
            options={options as PluginOptions | undefined}
            sessionID={props.session_id}
          />
        )
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
