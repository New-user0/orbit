import path from "path"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { plain } from "@orbit/flow/plain"
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { dialogWidth, useDialog } from "../../ui/dialog"
import { moveSelection } from "../../ui/select-controller"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import { bodyText } from "../../util/renderer"

/** A person's prompt, or with `shell` a command they ran with `!`, whose text is then the command. */
export type RewindPrompt = { id: string; text: string; created: number; shell?: boolean }
export type RewindOption = "both" | "conversation" | "code"
export type RewindFileStat = { file: string; additions: number; deletions: number }
export type RewindDryRun = {
  canRewind: boolean
  filesChanged?: readonly string[]
  insertions?: number
  deletions?: number
}

const VISIBLE_ROWS = 7
// How far page up and page down move in step 2, as far as the reference's select shows at once.
const PAGE = 5
const FULL_WIDTH_ONE = 0xff11

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
  const toast = useToast()
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
    // The option Enter chose, marked while its rewind runs; a digit chooses without marking.
    chosen: undefined as number | undefined,
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
  // Esc waits for a chosen rewind, but ctrl+c or a click outside still removes the picker. Its rewind's answer then
  // must not clear whatever dialog came next, and a refusal goes to a toast in place of the error line.
  let mounted = true
  onCleanup(() => (mounted = false))

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

  const choose = (index: number, mark: boolean) => {
    const prompt = state.prompt
    const current = options()[index]
    if (!prompt || state.acting) return
    if (current === "never") return back()
    setState({ acting: true, chosen: mark ? index : undefined })
    props.act(current, prompt.id).then(
      () => mounted && close(),
      (error) => {
        const message = `${failures[current]}: ${plain(errorMessage(error))}`
        if (mounted) return setState({ acting: false, step: "error", error: message })
        toast.show({ message, variant: "error", duration: 5000 })
      },
    )
  }

  // The list clamps at both ends; step 2's options wrap one step at a time, while its page keys, Home and End clamp.
  // Nothing moves while a chosen rewind runs, so the effect lines keep describing what was chosen.
  const move = (by: number, policy: "clamp" | "wrap" = "wrap") => {
    if (state.acting) return
    if (state.step === "list")
      setSelected((value) => moveSelection(value, { count: props.prompts.length + 1, delta: by, policy: "clamp" }))
    if (state.step === "confirm")
      setState("focused", moveSelection(state.focused, { count: options().length, delta: by, policy }))
  }
  // The list's own jumps to its oldest prompt and to "(current)"; the confirm step's options have none.
  const jump = (by: number) => {
    if (state.step === "list") move(by)
  }

  // The dialog keys every Orbit picker shares (rebindable, ctrl+p and ctrl+n by default), plus j and k and the list's
  // top and bottom chords. In step 2 a digit, ASCII or full-width, chooses the option drawn with that number without
  // moving the focus, and the page keys go to the first or last option. `n` closes the picker wherever Esc does.
  Keymap.createLayer(() => ({
    context: "dialog",
    mode: "modal",
    commands: [
      {
        bind: "escape",
        title: "Close rewind",
        group: "Dialog",
        run: () => {
          if (state.acting) return
          if (state.step === "confirm") return back()
          close()
        },
      },
      { id: "dialog.select.prev", title: "Previous", group: "Dialog", run: () => move(-1) },
      { id: "dialog.select.next", title: "Next", group: "Dialog", run: () => move(1) },
      { id: "dialog.select.home", title: "First", group: "Dialog", run: () => move(-Infinity, "clamp") },
      { id: "dialog.select.end", title: "Last", group: "Dialog", run: () => move(Infinity, "clamp") },
      ...[
        { id: "dialog.select.page_up", title: "Page up", by: -PAGE },
        { id: "dialog.select.page_down", title: "Page down", by: PAGE },
      ].map((page) => ({
        id: page.id,
        title: page.title,
        group: "Dialog",
        run: () => {
          if (state.step === "confirm") move(page.by, "clamp")
        },
      })),
      ...["ctrl+up", "shift+up", "meta+up", "shift+k"].map((bind) => ({
        bind,
        title: "Oldest prompt",
        group: "Dialog",
        run: () => jump(-Infinity),
      })),
      ...["ctrl+down", "shift+down", "meta+down", "shift+j"].map((bind) => ({
        bind,
        title: "Current",
        group: "Dialog",
        run: () => jump(Infinity),
      })),
      { bind: "k", title: "Previous", group: "Dialog", run: () => move(-1) },
      { bind: "j", title: "Next", group: "Dialog", run: () => move(1) },
      {
        bind: "n",
        title: "Close rewind",
        group: "Dialog",
        run: () => {
          if (state.step === "error" || !props.prompts.length) return close()
          // A picker opened on step 2 stands in for that step while it checks files, where `n` does nothing.
          if (state.step === "list" && !props.preselected) close()
        },
      },
      ...options().flatMap((_, index) =>
        [String(index + 1), String.fromCharCode(FULL_WIDTH_ONE + index)].map((bind) => ({
          bind,
          title: `Option ${index + 1}`,
          group: "Dialog",
          run: () => {
            if (state.step === "confirm") choose(index, false)
          },
        })),
      ),
      {
        id: "dialog.select.submit",
        title: "Choose",
        group: "Dialog",
        run: () => {
          if (state.step === "confirm") return choose(state.focused, true)
          if (state.step !== "list" || state.checking || !props.prompts.length) return
          const prompt = props.prompts[selected()]
          if (!prompt) return close()
          confirm(prompt.id)
        },
      },
    ],
  }))

  // A shell command is drawn behind the `!` that ran it. A list row is one truncated line; step 2 quotes the prompt's
  // first four lines and 500 characters, wrapped.
  const own = (prompt: RewindPrompt) => (prompt.shell ? `! ${prompt.text}` : prompt.text)
  const quote = (prompt: RewindPrompt) =>
    Locale.truncate(bodyText(own(prompt)).replace(/\n/g, " "), width()) || "(empty prompt)"
  // Cut by code point, so a cut never leaves half a surrogate pair to draw.
  const quoteLines = (prompt: RewindPrompt) =>
    bodyText(Array.from(own(prompt)).slice(0, 500).join("").split("\n").slice(0, 4).join("\n")) || "(empty prompt)"

  function Row(row: { index: number }) {
    const prompt = props.prompts[row.index]
    const active = () => selected() === row.index
    // A shell command has no file-tool edits of its own to count: the prompt-scoped diff answers only for a prompt.
    if (prompt && !prompt.shell) ask(prompt.id)
    const files = () => (prompt ? stats[prompt.id] : undefined)
    // Every row is three lines tall, its stats line kept before they load, so the window never shifts.
    return (
      <box flexDirection="row" flexShrink={0} height={3}>
        <text fg={theme.text.formfield.focused} flexShrink={0}>
          {active() ? "› " : "  "}
        </text>
        <box flexDirection="column" flexGrow={1}>
          <text
            fg={active() ? theme.text.formfield.focused : theme.text.formfield.base}
            wrapMode="none"
            overflow="hidden"
          >
            {prompt ? quote(prompt) : "(current)"}
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
                <text fg={theme.text.base}>{quoteLines(prompt())}</text>
                <text fg={theme.text.muted}>({Locale.ago(prompt().created)})</text>
              </box>
              <box flexDirection="column">
                <text fg={theme.text.muted}>{conversationEffect()}</text>
                <text fg={theme.text.muted}>{codeEffect()}</text>
              </box>
              <box flexDirection="column">
                <For each={options()}>
                  {(item, index) => {
                    // While a rewind runs no option is pointed at; the one Enter chose carries the check mark.
                    const pointed = () => index() === state.focused && !state.acting
                    const chosen = () => index() === state.chosen && state.acting
                    return (
                      <text
                        fg={
                          chosen()
                            ? theme.text.formfield.selected
                            : pointed()
                              ? theme.text.formfield.focused
                              : theme.text.formfield.base
                        }
                      >
                        {pointed() ? "› " : "  "}
                        {index() + 1}. {labels[item]}
                        {chosen() ? " ✓" : ""}
                      </text>
                    )
                  }}
                </For>
              </box>
              <Show when={state.acting}>
                <text fg={theme.text.muted}>Rewinding…</text>
              </Show>
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
