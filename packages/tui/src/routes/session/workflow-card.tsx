import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { SPINNER_FRAMES } from "../../component/spinner-frames"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { workflowPhases, type WorkflowAgent } from "../../util/tool-display"

/**
 * A workflow's agents as they run: a header with the totals, then each phase with its progress and one row per agent
 * (model, tokens, time). A phase folds once all its agents finished; selecting an agent opens its session.
 */
export function WorkflowCard(props: {
  description: string
  agents: WorkflowAgent[]
  running: boolean
  failed: boolean
}) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const { navigate } = useRoute()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => props.running && setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  const [toggled, setToggled] = createSignal<Record<string, boolean>>({})

  const phases = createMemo(() => workflowPhases(props.agents))
  const tokens = createMemo(() => props.agents.reduce((total, agent) => total + (agent.tokens ?? 0), 0))
  const started = createMemo(() => Math.min(...props.agents.map((agent) => agent.started ?? now())))
  const ended = createMemo(() =>
    props.running ? now() : Math.max(...props.agents.map((agent) => agent.ended ?? agent.started ?? now())),
  )
  const columns = createMemo(() => ({
    model: dimensions().width >= 80,
    tokens: dimensions().width >= 56,
  }))
  const elapsed = (agent: WorkflowAgent) =>
    agent.started === undefined ? "" : seconds((agent.ended ?? now()) - agent.started)
  const open = (name: string, agents: WorkflowAgent[]) =>
    toggled()[name] ?? agents.some((agent) => agent.status !== "completed")

  return (
    <box paddingLeft={3} flexShrink={0}>
      <box flexDirection="row" gap={1}>
        <text
          fg={props.failed ? theme.text.feedback.error.base : props.running ? theme.brand.base : theme.text.muted}
          flexShrink={0}
        >
          {props.failed ? "✕" : props.running ? SPINNER_FRAMES[Math.floor(now() / 1000) % 4] : "◇"}
        </text>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
          Workflow
        </text>
        <text fg={theme.text.muted} flexGrow={1} flexShrink={1} wrapMode="none">
          {props.description}
        </text>
        <text fg={theme.text.muted} flexShrink={0} wrapMode="none">
          {[
            `${props.agents.length} agent${props.agents.length === 1 ? "" : "s"}`,
            tokens() > 0 ? `${Locale.number(tokens())} tokens` : undefined,
            props.agents.length > 0 ? seconds(ended() - started()) : undefined,
          ]
            .filter(Boolean)
            .join(" · ")}
        </text>
      </box>
      <For each={phases()}>
        {(phase) => {
          const done = () => phase.agents.filter((agent) => agent.status === "completed").length
          return (
            <box paddingLeft={2}>
              <Show when={phase.name}>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseUp={() => setToggled((value) => ({ ...value, [phase.name]: !open(phase.name, phase.agents) }))}
                >
                  <text fg={theme.text.base} flexShrink={0}>
                    {phase.name}
                  </text>
                  <text flexShrink={0}>
                    <For each={phase.agents}>
                      {(agent) => (
                        <span
                          style={{
                            fg:
                              agent.status === "failed"
                                ? theme.text.feedback.error.base
                                : agent.status === "completed"
                                  ? theme.brand.base
                                  : theme.text.muted,
                          }}
                        >
                          {agent.status === "running" ? "▫" : "▪"}
                        </span>
                      )}
                    </For>
                  </text>
                  <box flexGrow={1} />
                  <text fg={theme.text.muted} flexShrink={0}>
                    {`${done()}/${phase.agents.length} ${open(phase.name, phase.agents) ? "▾" : "▸"}`}
                  </text>
                </box>
              </Show>
              <Show when={!phase.name || open(phase.name, phase.agents)}>
                <For each={phase.agents}>
                  {(agent) => (
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={phase.name ? 2 : 0}
                      onMouseUp={() => navigate({ type: "session", sessionID: agent.sessionID })}
                    >
                      <text
                        flexShrink={0}
                        fg={
                          agent.status === "failed"
                            ? theme.text.feedback.error.base
                            : agent.status === "running"
                              ? theme.brand.base
                              : theme.text.feedback.success.base
                        }
                      >
                        {agent.status === "failed"
                          ? "✕"
                          : agent.status === "running"
                            ? SPINNER_FRAMES[Math.floor(now() / 1000) % 4]
                            : "●"}
                      </text>
                      <text fg={theme.text.base} flexGrow={1} flexShrink={1} wrapMode="none">
                        {agent.description}
                      </text>
                      <Show when={columns().model}>
                        <text fg={theme.text.muted} width={18} flexShrink={0} wrapMode="none">
                          {agent.model ?? Locale.titlecase(agent.agent)}
                        </text>
                      </Show>
                      <Show when={columns().tokens}>
                        <text fg={theme.text.muted} width={7} flexShrink={0} wrapMode="none">
                          {(agent.tokens === undefined ? "" : Locale.number(agent.tokens)).padStart(7)}
                        </text>
                      </Show>
                      <text fg={theme.text.muted} width={6} flexShrink={0} wrapMode="none">
                        {elapsed(agent).padStart(6)}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function seconds(milliseconds: number) {
  const total = Math.max(0, Math.round(milliseconds / 1000))
  if (total < 60) return `${total}s`
  return `${Math.floor(total / 60)}m ${total % 60}s`
}
