import path from "path"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { plain } from "@orbit/flow/plain"
import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { dialogWidth, useDialog } from "../../ui/dialog"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import { bodyText } from "../../util/renderer"

export type RewindPrompt = { id: string; text: string; created: number }
export type RewindOption = "both" | "conversation" | "code"
export type RewindFileStat = { file: string; additions: number; deletions: number }
export type RewindDryRun = {
  canRewind: boolean
  filesChanged?: readonly string[]
  insertions?: number
  deletions?: number
}

const VISIBLE_ROWS = 7

const labels: Record<RewindOption | "never", string> = {
  both: "Code and conversation",
  conversation: "Conversation only",
  code: "Code only",
  never: "Never mind",
}

const failures: Record<RewindOption, string> = {
  both: "Could not rewind the code and conversation",
  conversation: "Could not rewind the conversation",
  code: "Could not rewind the code",
}

/**
 * The rewind picker. Step 1 lists the person's prompts, oldest first, with a "(current)" row; step 2 confirms one
 * prompt and offers the code options only when a dry run says a rewind would change files now. Data and actions come
 * in as props, so the session route passes client calls and the storybook passes fixtures.
 */
export function DialogRewind(props: {
  prompts: readonly RewindPrompt[]
  /** The prompt's own file-tool edits; a rejection draws that row's warning. */
  stats: (messageID: string) => Promise<readonly RewindFileStat[]>
  /** What a code rewind to the prompt would change now; a rejection or `undefined` leaves only the conversation. */
  dryRun: (messageID: string) => Promise<RewindDryRun | undefined>
  act: (option: RewindOption, messageID: string) => Promise<void>
  onClose: () => void
  /** Opens on step 2 for this prompt; Esc and Never mind then close instead of going back to the list. */
  preselected?: string
}) {
  const dialog = useDialog()
  const theme = useTheme().surface("dialog")
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => Math.max(10, Math.min(dialogWidth("xlarge"), dimensions().width - 2) - 6))
  const [selected, setSelected] = createSignal(props.prompts.length)
  const [state, setState] = createStore({
    step: "list" as "list" | "confirm" | "error",
    checking: false,
    acting: false,
    error: "",
    prompt: undefined as RewindPrompt | undefined,
    code: undefined as { files: readonly string[]; insertions: number; deletions: number } | undefined,
    focused: 0,
  })
  const [stats, setStats] = createStore<Record<string, readonly RewindFileStat[] | "failed">>({})
  const asked = new Set<string>()

  onMount(() => {
    dialog.setSize("xlarge")
    if (props.preselected) confirm(props.preselected)
  })

  const ask = (messageID: string) => {
    if (asked.has(messageID)) return
    asked.add(messageID)
    props.stats(messageID).then(
      (files) => setStats(messageID, Array.isArray(files) ? files : "failed"),
      () => setStats(messageID, "failed"),
    )
  }

  const options = createMemo((): (RewindOption | "never")[] =>
    state.code ? ["both", "conversation", "code", "never"] : ["conversation", "never"],
  )
  const option = () => options()[state.focused]

  const rows = createMemo(() => {
    const total = props.prompts.length + 1
    const start = Math.max(0, Math.min(selected() - Math.floor(VISIBLE_ROWS / 2), total - VISIBLE_ROWS))
    return Array.from({ length: Math.min(VISIBLE_ROWS, total) }, (_, offset) => start + offset)
  })

  // Closing removes the picker, so a dry run that answers later has nothing left to update.
  const close = () => props.onClose()

  function confirm(messageID: string) {
    const prompt = props.prompts.find((item) => item.id === messageID)
    if (!prompt) return close()
    setState("checking", true)
    props
      .dryRun(messageID)
      .catch(() => undefined)
      .then((result) => {
        const files = result?.canRewind && Array.isArray(result.filesChanged) ? result.filesChanged : []
        setState({
          checking: false,
          step: "confirm",
          prompt,
          focused: 0,
          code: files.length
            ? { files, insertions: result?.insertions ?? 0, deletions: result?.deletions ?? 0 }
            : undefined,
        })
      })
  }

  const back = () => {
    if (props.preselected) return close()
    setState({ step: "list", prompt: undefined, code: undefined, focused: 0 })
  }

  const choose = () => {
    const prompt = state.prompt
    const current = option()
    if (!prompt || state.acting) return
    if (current === "never") return back()
    setState("acting", true)
    props
      .act(current, prompt.id)
      .then(close, (error) =>
        setState({ acting: false, step: "error", error: `${failures[current]}: ${plain(errorMessage(error))}` }),
      )
  }

  const move = (by: number) => {
    if (state.step === "list") {
      setSelected((value) => Math.max(0, Math.min(props.prompts.length, value + by)))
      return
    }
    if (state.step === "confirm") setState("focused", Math.max(0, Math.min(options().length - 1, state.focused + by)))
  }

  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      {
        bind: "escape",
        title: "Close rewind",
        group: "Dialog",
        run: () => (state.step === "confirm" ? back() : close()),
      },
      { bind: "up", title: "Previous", group: "Dialog", run: () => move(-1) },
      { bind: "down", title: "Next", group: "Dialog", run: () => move(1) },
      { bind: "home", title: "First", group: "Dialog", run: () => move(-Infinity) },
      { bind: "end", title: "Last", group: "Dialog", run: () => move(Infinity) },
      {
        bind: "return",
        title: "Choose",
        group: "Dialog",
        run: () => {
          if (state.step === "confirm") return choose()
          if (state.step !== "list" || state.checking) return
          const prompt = props.prompts[selected()]
          if (!prompt) return close()
          confirm(prompt.id)
        },
      },
    ],
  }))

  const line = (text: string) => Locale.truncate(bodyText(text).replace(/\n/g, " "), width())

  function Row(row: { index: number }) {
    const prompt = props.prompts[row.index]
    const active = () => selected() === row.index
    if (prompt) ask(prompt.id)
    const files = () => (prompt ? stats[prompt.id] : undefined)
    return (
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.text.formfield.focused} flexShrink={0}>
          {active() ? "› " : "  "}
        </text>
        <box flexDirection="column" flexGrow={1}>
          <text
            fg={active() ? theme.text.formfield.focused : theme.text.formfield.base}
            wrapMode="none"
            overflow="hidden"
          >
            {prompt ? line(prompt.text) || "(empty prompt)" : "(current)"}
          </text>
          <Show when={files()}>{(value) => <FileStats files={value()} />}</Show>
        </box>
      </box>
    )
  }

  function FileStats(input: { files: readonly RewindFileStat[] | "failed" }) {
    return (
      <Switch>
        <Match when={input.files === "failed"}>
          <text fg={theme.text.feedback.warning.base}>⚠ No code rewind for this prompt</text>
        </Match>
        <Match when={input.files.length === 0}>
          <text fg={theme.text.muted}>No file edits</text>
        </Match>
        <Match when={typeof input.files !== "string" && input.files}>
          {(files) => (
            <text fg={theme.text.muted} wrapMode="none" overflow="hidden">
              {files().length === 1 ? plain(path.basename(files()[0].file)) : `${files().length} files`}{" "}
              <span style={{ fg: theme.diff.text.added }}>
                +{files().reduce((sum, file) => sum + file.additions, 0)}
              </span>{" "}
              <span style={{ fg: theme.diff.text.removed }}>
                -{files().reduce((sum, file) => sum + file.deletions, 0)}
              </span>
            </text>
          )}
        </Match>
      </Switch>
    )
  }

  const conversationEffect = () =>
    option() === "both" || option() === "conversation"
      ? "The conversation goes back to this point. /redo brings it back until your next prompt."
      : "The conversation stays as it is."

  const codeEffect = () => {
    const code = state.code
    if (!code || (option() !== "both" && option() !== "code")) return "The code stays as it is."
    const names = code.files.map((file) => plain(path.basename(file)))
    const label =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names[0]} and ${names.length - 1} other files`
    return `Files go back: +${code.insertions} -${code.deletions} in ${label}.`
  }

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text.base}>
          Rewind
        </text>
        <text fg={theme.text.muted}>esc</text>
      </box>
      <Switch>
        <Match when={state.step === "error"}>
          <text fg={theme.text.feedback.error.base}>{state.error}</text>
        </Match>
        <Match when={state.step === "confirm" && state.prompt}>
          {(prompt) => (
            <box flexDirection="column" gap={1}>
              <text fg={theme.text.base}>
                {state.code
                  ? "Rewind to just before this prompt:"
                  : "Rewind the conversation to just before this prompt:"}
              </text>
              <box border={["left"]} borderColor={theme.border.base} paddingLeft={1} flexDirection="column">
                <text fg={theme.text.base} wrapMode="none" overflow="hidden">
                  {line(prompt().text) || "(empty prompt)"}
                </text>
                <text fg={theme.text.muted}>({Locale.ago(prompt().created)})</text>
              </box>
              <box flexDirection="column">
                <text fg={theme.text.muted}>{conversationEffect()}</text>
                <text fg={theme.text.muted}>{codeEffect()}</text>
              </box>
              <box flexDirection="column">
                <For each={options()}>
                  {(item, index) => (
                    <text fg={index() === state.focused ? theme.text.formfield.focused : theme.text.formfield.base}>
                      {index() === state.focused ? "› " : "  "}
                      {labels[item]}
                    </text>
                  )}
                </For>
              </box>
              <Show when={state.code}>
                <text fg={theme.text.feedback.warning.base}>
                  ⚠ Only edits made by Orbit's file tools go back; shell commands and edits made outside Orbit stay.
                </text>
              </Show>
            </box>
          )}
        </Match>
        <Match when={props.prompts.length === 0}>
          <text fg={theme.text.muted}>Nothing to rewind yet.</text>
        </Match>
        <Match when={props.preselected}>
          <text fg={theme.text.muted}>Checking files…</text>
        </Match>
        <Match when={state.step === "list"}>
          <box flexDirection="column" gap={1}>
            <text fg={theme.text.base}>Rewind the code, the conversation or both to just before…</text>
            <box flexDirection="column">
              <For each={rows()}>{(index) => <Row index={index} />}</For>
            </box>
            <text fg={theme.text.muted}>{state.checking ? "Checking files…" : "enter continue · esc close"}</text>
          </box>
        </Match>
      </Switch>
    </box>
  )
}
