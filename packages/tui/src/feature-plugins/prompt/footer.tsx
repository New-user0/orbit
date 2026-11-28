import { Plugin } from "@orbit/plugin/tui"
import { createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { contextBar, contextUsage, formatContextUsage } from "../../util/session"
import { useTerminalDimensions } from "@opentui/solid"
import { stringWidth } from "../../util/string-width"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type PromptFooterProps = {
  context: Plugin.Context
  sessionID?: string
  mode: "normal" | "shell"
  showDetails: boolean
}

export function PromptFooter(props: PromptFooterProps) {
  // Only a fresh report inside the warning band is drawn; any other state is not known to this client. A staged revert
  // rewinds the context, so the report does not describe it until the revert is cleared.
  const warning = createMemo(() => {
    if (!props.sessionID || !props.showDetails) return
    const report = props.context.data.session.context(props.sessionID)
    if (!report || report.stale || (report.state !== "warning" && report.state !== "error")) return
    if (props.context.data.session.get(props.sessionID)?.revert) return
    if (report.auto)
      return { color: props.context.theme.text.muted, text: `${report.percentLeft}% left before auto-compaction` }
    return {
      color:
        report.state === "error"
          ? props.context.theme.text.feedback.error.base
          : props.context.theme.text.feedback.warning.base,
      text: `Context almost full (${report.percentLeft}% left) · run /compact`,
    }
  })

  return (
    <>
      <Show when={warning()}>
        {(line) => (
          <text fg={line().color} wrapMode="none" flexShrink={0} minWidth={0}>
            {line().text}
          </text>
        )}
      </Show>
      <PromptFooterStatus {...props} warning={warning()} />
    </>
  )
}

// While a warning is drawn it replaces the context bar, which it reports more precisely, and the shortcuts give way to
// it when the row cannot hold both.
function PromptFooterStatus(props: PromptFooterProps & { warning?: { text: string } }) {
  const dimensions = useTerminalDimensions()
  const [liveHovered, setLiveHovered] = createSignal(false)
  const subagents = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.session
      .family(props.sessionID)
      .filter((id) => id !== props.sessionID && props.context.data.session.status(id) === "running").length
    return count ? `${count} agent${count === 1 ? "" : "s"}` : undefined
  })
  const shells = createMemo(() => {
    if (!props.sessionID) return 0
    const count = props.context.data.shell
      .list(props.context.location)
      .filter((shell) => shell.metadata.sessionID === props.sessionID).length
    return count ? `${count} shell${count === 1 ? "" : "s"}` : undefined
  })
  const status = createMemo(() => {
    if (!props.sessionID) return []
    const session = props.context.data.session.get(props.sessionID)
    if (!session) return []
    const usage = contextUsage(
      props.context.data.session.message.list(props.sessionID),
      props.context.data.location.model.list(session.location),
      session.revert?.messageID,
    )
    const cost = props.context.data.session.cost(props.sessionID)
    return [
      usage && !props.warning
        ? usage.percent === undefined
          ? formatContextUsage(usage.tokens)
          : contextBar(usage.percent)
        : undefined,
      cost > 0 ? money.format(cost) : undefined,
    ].filter((item): item is string => Boolean(item))
  })
  const live = createMemo(() => Boolean(subagents() || shells()))
  const shortcut = (id: string) => props.context.keymap.shortcuts(id)[0]
  const layout = createMemo(() => {
    const command = shortcut("command.palette.show")
    const usage = props.warning ? [props.warning.text, ...status()] : status()
    if (usage.length === 0) return { usage: false, shortcuts: dimensions().width >= 44 }
    return promptFooterLayout({
      width: Math.max(0, dimensions().width - 8),
      usage,
      shortcuts: command ? [`${command} commands`] : [],
    })
  })

  return (
    <Switch>
      <Match when={props.mode === "normal"}>
        <Switch>
          <Match when={live() || status().length > 0}>
            <box flexDirection="row" flexShrink={props.showDetails && layout().usage ? 0 : 1} minWidth={0}>
              <Show when={live()}>
                <box
                  flexShrink={0}
                  onMouseOver={() => setLiveHovered(true)}
                  onMouseOut={() => setLiveHovered(false)}
                  onMouseUp={() => props.context.keymap.dispatch(subagents() ? "agent.map" : "session.child.first")}
                >
                  <text
                    fg={liveHovered() ? props.context.theme.text.base : props.context.theme.text.muted}
                    wrapMode="none"
                  >
                    <Show when={subagents()}>
                      {(value) => (
                        <>
                          <span style={{ fg: props.context.theme.text.feedback.success.base }}>● </span>
                          {value()}
                        </>
                      )}
                    </Show>
                    <Show when={!subagents() && shortcut("session.child.first")}>
                      {(value) => <span style={{ fg: props.context.theme.text.base }}>{value()} </span>}
                    </Show>
                    <Show when={subagents() && shells()}> · </Show>
                    <Show when={shells()}>{(value) => <>{value()}</>}</Show>
                  </text>
                </box>
              </Show>
              <Show when={props.showDetails && layout().usage && status().length > 0}>
                <text fg={props.context.theme.text.muted} wrapMode="none" flexShrink={0}>
                  <Show when={live()}> · </Show>
                  {status().join(" · ")}
                </text>
              </Show>
            </box>
          </Match>
          <Match when={props.showDetails && layout().shortcuts}>
            <text fg={props.context.theme.text.base} flexShrink={0}>
              {shortcut("agent.cycle")} <span style={{ fg: props.context.theme.text.muted }}>agents</span>
            </text>
          </Match>
        </Switch>
        <Show when={props.showDetails && layout().shortcuts}>
          <text fg={props.context.theme.text.base} wrapMode="none" flexShrink={0}>
            {shortcut("command.palette.show")} <span style={{ fg: props.context.theme.text.muted }}>commands</span>
          </text>
        </Show>
      </Match>
      <Match when={props.mode === "shell"}>
        <text fg={props.context.theme.text.base} flexShrink={0}>
          esc{" "}
          <span style={{ fg: props.context.theme.text.muted }}>
            {dimensions().width < 44 ? "shell" : "exit shell mode"}
          </span>
        </text>
      </Match>
    </Switch>
  )
}

export default Plugin.define({
  id: "orbit.prompt.footer",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer",
      render: (props) => (
        <PromptFooter context={context} sessionID={props.sessionID} mode={props.mode} showDetails={props.showDetails} />
      ),
    })
  },
})

function promptFooterLayout(input: { width: number; usage: string[]; shortcuts: string[] }) {
  const usage = input.usage.join(" · ")
  const shortcuts = input.shortcuts.join(" · ")
  const available = Math.max(0, input.width - Math.min(28, Math.floor(input.width / 2)))
  if (usage && shortcuts && stringWidth(`${usage} · ${shortcuts}`) <= available) {
    return { usage: true, shortcuts: true }
  }
  if (usage && stringWidth(usage) <= available) return { usage: true, shortcuts: false }
  if (!usage && shortcuts && stringWidth(shortcuts) <= available) return { usage: false, shortcuts: true }
  return { usage: false, shortcuts: false }
}
