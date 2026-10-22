import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, For, onMount, Show, untrack } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { plain } from "@orbit/flow/plain"
import { withTimestampedFallback } from "@orbit/util/session-title-fallback"
import { Locale } from "../util/locale"
import { useArgs } from "../context/args"
import { useRoute, useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { useEditorContext } from "../context/editor"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { useTrust, useTrustPrompt } from "../context/trust"
import { FormPrompt } from "./session/form"
import { Slot } from "../plugin/render"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useUpdateNotification } from "../context/update-notification"
import { useExit } from "../context/exit"
import { FadeInText } from "../component/fade-in-text"

let once = false
const tips = [
  { key: "/init", label: "write AGENTS.md for this repo" },
  { key: "@file", label: "attach a file as context" },
  { key: "!cmd", label: "run a shell command" },
]
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function Home() {
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const data = useData()
  const location = useLocation()
  const dimensions = useTerminalDimensions()
  // Global MCP elicitations can arrive without a session route, so keep them reachable from Home.
  const currentLocation = () => route.location ?? data.location.default()
  const forms = createMemo(() => data.session.form.list("global", currentLocation()) ?? [])
  let sent = false

  // Track only the route location and (when absent) the default location; location.set
  // reads other signals internally and tracking them would re-assert the route location
  // after the user overrides it with /cd.
  createEffect(() => {
    const target = currentLocation()
    untrack(() => location.set(target))
  })
  useTrustPrompt()
  const trust = useTrust()

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r || route.prompt || !args.prompt) return
    r.set({ text: args.prompt, files: [], agents: [], pasted: [] })
    once = true
  }

  createEffect(() => {
    const composer = ref()
    const prompt = route.prompt
    if (!composer || prompt?.text === undefined) return
    untrack(() => composer.set(prompt))
  })

  // Wait for everything submit needs before auto-submitting --prompt, the folder's trust among it; it runs once.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r || !trust.typing()) return
    if (!local.model.ready || !local.model.catalogReady) return
    if (!local.agent.current() || !local.model.current()) return
    if (!args.prompt) return
    if (r.current.text !== args.prompt) return
    sent = true
    r.submit()
  })

  const theme = useTheme()
  const routes = useRoute()
  const recent = createMemo(() => {
    const directory = currentLocation()?.directory
    return data.session
      .list()
      .filter((session) => !session.parentID && session.location.directory === directory)
      .toSorted((left, right) => right.time.updated - left.time.updated)
      .slice(0, 3)
  })
  const agent = () => {
    const current = local.agent.current()
    return current ? Locale.titlecase(current.id) : "Build"
  }
  const narrow = () => dimensions().width < 44

  return (
    <>
      <box flexGrow={1} minHeight={0} paddingLeft={narrow() ? 1 : 4} paddingRight={narrow() ? 1 : 4}>
        <box flexGrow={1} minHeight={0} flexShrink={1} overflow="hidden" paddingTop={1} gap={1}>
          <box flexShrink={0}>
            <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
              Welcome back.
            </text>
            <text fg={theme.text.muted} wrapMode="none">
              {`${agent()} mode · ${local.model.parsed().model}`}
            </text>
          </box>
          <Show when={recent().length > 0 && dimensions().height >= 20}>
            <box flexShrink={0}>
              <text fg={theme.text.muted}>recent</text>
              <For each={recent()}>
                {(session) => (
                  <box
                    flexDirection="row"
                    gap={2}
                    onMouseUp={() => routes.navigate({ type: "session", sessionID: session.id })}
                  >
                    <text fg={theme.brand.base}>◦</text>
                    <text fg={theme.text.base} flexGrow={1} flexShrink={1} wrapMode="none">
                      {plain(withTimestampedFallback(session))}
                    </text>
                    <text fg={theme.text.muted} flexShrink={0}>
                      {Locale.ago(session.time.updated)}
                    </text>
                  </box>
                )}
              </For>
            </box>
          </Show>
          <Show when={dimensions().height >= 16}>
            <box flexShrink={0}>
              <text fg={theme.text.muted}>try</text>
              <For each={tips}>
                {(tip) => (
                  <text wrapMode="none">
                    <span style={{ fg: theme.brand.base }}>{tip.key.padEnd(10)}</span>
                    <span style={{ fg: theme.text.muted }}>{tip.label}</span>
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
        <UpdateNotification width={dimensions().width} />
        <box width="100%" zIndex={1000} paddingTop={1} paddingBottom={1} flexShrink={0} position="relative">
          <Prompt ref={bind} placeholders={placeholder} disabled={forms().length > 0} />
        </box>
      </box>
      <box width="100%" flexShrink={0}>
        <Slot path="home.footer" />
      </box>
      <Show when={forms()[0]?.id} keyed>
        {(_) => {
          const form = forms()[0]
          return form ? (
            <box position="absolute" zIndex={2000} left={0} right={0} bottom={1} paddingLeft={2} paddingRight={2}>
              <box width="100%">
                <FormPrompt form={form} />
              </box>
            </box>
          ) : null
        }}
      </Show>
    </>
  )
}

function UpdateNotification(props: { width: number }) {
  const update = useUpdateNotification()
  const exit = useExit()
  const theme = useTheme()
  const [hovered, setHovered] = createSignal(false)
  const backdrop = () => (hovered() ? theme.background.action.primary.hovered : theme.background.base)
  createEffect(() => {
    update.notification()
    setHovered(false)
  })

  return (
    <Show when={update.notification()} keyed>
      {(state) => {
        const remote = state.source === "server" && state.remote
        return (
          <Show when={!remote || state.type === "available"}>
            <box
              flexShrink={0}
              flexDirection="row"
              justifyContent="center"
              width={props.width}
              maxWidth="100%"
              gap={1}
              backgroundColor={hovered() ? theme.background.action.primary.hovered : undefined}
              onMouseOver={() => setHovered(true)}
              onMouseOut={() => setHovered(false)}
              onMouseUp={() => {
                if (remote) return update.dismiss()
                if (state.type === "installed") return exit()
                update.open?.("notification")
              }}
            >
              <FadeInText fg={theme.text.muted} backdrop={backdrop()}>
                <Show when={!remote}>
                  <span style={{ fg: theme.text.action.primary.selected }}>
                    {state.type === "installed" ? "/exit" : "/update"}
                  </span>
                </Show>
                {remote
                  ? "remote server update available"
                  : state.type === "installed"
                    ? ` restart to use v${state.version}`
                    : ` to install v${state.version}`}
              </FadeInText>
            </box>
          </Show>
        )
      }}
    </Show>
  )
}
