import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, useContext } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { plain, plainPath } from "@orbit/util/plain"
import { useTheme, useThemes } from "../../context/theme"
import type { PermissionReply, PermissionRequest } from "@orbit/client"
import { SplitBorder } from "../../ui/border"
import { useClient } from "../../context/client"
import { useData } from "../../context/data"
import { EditorContext, type EditorDiff, type EditorDiffEvent } from "../../context/editor"
import { useLog } from "../../context/log"
import { TrustContext } from "../../context/trust"
import { isRecord } from "../../util/record"
import { filetype } from "../../util/filetype"
import { canonicalToolName } from "../../util/tool-display"
import { permissionAlwaysLines, permissionLinks, permissionOptionLabel, permissionPresentation } from "../../util/permission"
import { getScrollAcceleration } from "../../util/scroll"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"
import { useConfig } from "../../config"
import { Keymap } from "../../context/keymap"
import { useInteractivity } from "../../context/interactivity"
import { usePathFormatter } from "../../context/path-format"
import { SimulationSemantics } from "../../simulation/semantics"
import { Hanging, hangingLead } from "../../component/hanging"
import { PatchDiff } from "../../component/patch-diff"
import { useToast } from "../../ui/toast"

type PermissionStage = "permission" | "reject"
/**
 * The room a question has in its dialog: `rows` for the header, the `gap` under it and the body, above the options and
 * the hints, and `width` for a line of either.
 */
type Space = { rows: () => number; width: () => number; gap: () => number }
// The rows that the scrolling body of an edit keeps, whatever the header above it holds.
const BODY_ROWS = 2
const DIALOG_ROWS = 15

function EditBody(props: {
  file?: string
  diff?: string
  diffs?: { file: string; diff: string }[]
  patch?: string
  /** The warning of each link that the fixed line does not say whole: they lead what scrolls. */
  warnings: string[]
  /** The names that a cut title no longer shows whole. */
  names: string[]
}) {
  const theme = useTheme()
  const themes = useThemes()
  const syntax = themes.currentSyntax
  const config = useConfig().data
  const dimensions = useTerminalDimensions()

  // A patch that edits several files gets one diff per file, each under its own path.
  const diffs = createMemo(() => props.diffs ?? (props.diff ? [{ file: props.file ?? "", diff: props.diff }] : []))
  const several = () => diffs().length > 1
  // A name that is above its file's diff is not listed again: what is left is a move's source, or the only file's.
  const unnamed = () => props.names.filter((name) => !several() || !diffs().some((item) => item.file === name))

  const view = createMemo(() => {
    const diffView = config.diffs?.view
    if (diffView === "unified") return "unified"
    if (diffView === "split") return "split"
    return dimensions().width > 120 ? "split" : "unified"
  })

  return (
    <BodyScroll fill={diffs().length > 0 || Boolean(props.patch)}>
      {/* One box for all that scrolls, so the rows it can have are not split between two. */}
      <box flexDirection="column" flexShrink={0} gap={1}>
        <Show when={props.warnings.length > 0}>
          <Listed warnings={props.warnings} />
        </Show>
        <Show when={unnamed().length > 0}>
          <Listed names={unnamed()} lead="Path: " />
        </Show>
        <For each={diffs()}>
          {(item) => (
            <box flexDirection="column">
              <Show when={several()}>
                <box paddingLeft={1}>
                  <Hanging text={`Path: ${item.file}`} fg={theme.text.muted} />
                </box>
              </Show>
              <PatchDiff
                diff={item.diff}
                hunkFg={theme.diff.text.hunkHeader}
                view={view()}
                filetype={filetype(item.file)}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode="word"
                fg={theme.text.base}
                addedBg={theme.diff.background.added}
                removedBg={theme.diff.background.removed}
                contextBg={theme.diff.background.context}
                addedSignColor={theme.diff.highlight.added}
                removedSignColor={theme.diff.highlight.removed}
                lineNumberFg={theme.diff.lineNumber.text}
                lineNumberBg={theme.diff.background.context}
                addedLineNumberBg={theme.diff.lineNumber.background.added}
                removedLineNumberBg={theme.diff.lineNumber.background.removed}
              />
            </box>
          )}
        </For>
        <Show when={diffs().length === 0}>
          <Show
            when={props.patch}
            fallback={
              <box paddingLeft={1} flexShrink={0}>
                <text fg={theme.text.muted}>No diff provided</text>
              </box>
            }
          >
            {(patch) => (
              // Right of where a wrapped warning's first word ends, since this text's rows are the request's.
              <box paddingLeft={3} flexShrink={0}>
                <code
                  filetype="diff"
                  drawUnstyledText={false}
                  streaming={true}
                  syntaxStyle={syntax()}
                  content={patch()}
                  fg={theme.text.muted}
                />
              </box>
            )}
          </Show>
        </Show>
      </box>
    </BodyScroll>
  )
}

/**
 * What a question has under its header. A row in it is always a whole row: none shrinks, and what does not fit scrolls,
 * which the bar beside it shows (class 8). It is as high as what it holds, so a short question keeps a short dialog,
 * unless it fills the dialog, as a diff's does.
 */
function BodyScroll(props: { children: JSX.Element; fill?: boolean }) {
  const theme = useTheme()
  const config = useConfig().data
  let scroll: ScrollBoxRenderable | undefined
  // A step of the wheel keeps a row of what the body showed, which can be two: no row, and no name across two, is
  // skipped. A body of one row moves by that row.
  const scrollAcceleration = createMemo(() => {
    const base = getScrollAcceleration(config)
    return {
      tick: (now?: number) => Math.min(base.tick(now), Math.max(1, (scroll?.viewport.height ?? 1) - 1)),
      reset: () => base.reset(),
    }
  })
  return (
    <scrollbox
      flexShrink={1}
      height={props.fill ? "100%" : undefined}
      contentOptions={{ minHeight: props.fill ? "100%" : 0 }}
      ref={(item: ScrollBoxRenderable) => (scroll = item)}
      scrollAcceleration={scrollAcceleration()}
      verticalScrollbarOptions={{
        // In the dialog's padding, so no row is narrower for it: a row that narrowed when the bar came would lose its
        // last cell, and with it a character of what is approved, or bring and take the bar without end.
        position: "absolute",
        top: 0,
        bottom: 0,
        right: -1,
        trackOptions: {
          backgroundColor: theme.background.base,
          foregroundColor: theme.scrollbar.base,
        },
      }}
    >
      {props.children}
    </scrollbox>
  )
}

// Each warning and name that the fixed lines do not say whole, where it scrolls.
function Listed(props: { warnings?: string[]; names?: string[]; lead?: string }) {
  const theme = useTheme()
  return (
    <box paddingLeft={1} flexDirection="column" flexShrink={0}>
      <For each={props.warnings}>
        {(warning) => <Hanging text={warning} fg={theme.text.feedback.warning.base} />}
      </For>
      <For each={props.names}>{(name) => <Hanging lead={props.lead} text={name} fg={theme.text.muted} />}</For>
    </box>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest; directory?: string }) {
  const data = useData()
  const toast = useToast()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })
  const pathFormatter = usePathFormatter()
  const session = createMemo(() => data.session.get(props.request.sessionID))

  const source = createMemo(() => {
    const tool = props.request.source
    if (!tool) return { input: undefined, metadata: undefined }
    const message = data.session.message.get(props.request.sessionID, tool.messageID)
    if (message?.type !== "assistant") return { input: undefined, metadata: undefined }
    const part = message.content.find((part) => part.type === "tool" && part.id === tool.id)
    if (part?.type === "tool" && part.state.status !== "streaming") {
      return { input: part.state.input, metadata: part.state.metadata, tool: part.name }
    }
    return { input: undefined, metadata: undefined }
  })

  const theme = useTheme()
  const links = createMemo(() => permissionLinks(props.request, pathFormatter.format))
  const review = useEditorReview(props.request, () => session()?.location)

  function reply(value: PermissionReply, message?: string) {
    void data.session.permission
      .reply({ sessionID: props.request.sessionID, requestID: props.request.id, decision: value, message })
      .catch((error: unknown) => {
        // Refused: the question is still pending, and is asked here again.
        toast.error(error)
        review.ask()
      })
    // Answered here, so the editor's tab of it closes; the short prompt stays until the request goes away.
    review.close()
  }

  function select(option: string) {
    if (option === "always") return reply("always")
    if (option !== "reject") return reply("once")
    // A subagent's question is rejected with a word for it first.
    if (session()?.parentID) return void setStore("stage", "reject")
    reply("reject")
  }

  return (
    <Switch>
      <Match when={store.stage === "permission" && review.open()}>
        <EditorDiffPrompt request={props.request} editor={review.editor()} onSelect={select} />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          action={props.request.action}
          instance={props.request.id}
          links={links()}
          onConfirm={(message) => {
            reply("reject", message || undefined)
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const current = permissionPresentation(
            {
              action: props.request.action,
              resources: props.request.resources,
              metadata: props.request.metadata,
              input: source().input,
              toolMetadata: source().metadata,
              tool: source().tool,
            },
            pathFormatter.format,
          )
          // The views are written against the names the tools had before the rename, whichever one the request carries.
          const view = () => canonicalToolName(props.request.action)
          // A title is one line, whatever pattern, query or description is in it.
          const title = view() !== "shell" && current.title ? plain(current.title) : "Permission required"
          // How the header is fitted (class 8): the body keeps what a person approves, which is the grant while Always
          // allow is focused and otherwise rows to scroll in (two of an edit, one of another question, whose title often
          // says what its body does), and the fixed line and the title take the rows that are left. One link is said whole
          // while that takes half of those at most. Where the dialog has no row for both, the short summary shares the
          // title's. What is cut or summed up is whole in the body, whichever option is focused.
          const layout = (granting: boolean, space: Space) => {
            const granted = granting ? permissionAlwaysLines(props.request) : []
            const lines = granted.reduce((total, line) => total + wrappedRows(line, space.width()), 0)
            const kept = granting ? lines : view() === "edit" ? BODY_ROWS : 1
            const beside = links().summary && space.rows() < 3 ? links().short : undefined
            const rows = Math.max(links().summary && !beside ? 2 : 1, space.rows() - space.gap() - kept)
            const notice = beside
              ? { text: undefined, rows: 0, whole: false }
              : fitLinks(links(), Math.floor(rows / 2), space.width())
            const counted = [changes().additions, changes().deletions]
              .filter((count) => count > 0)
              .reduce((total, count) => total + stringWidth(`+${count}`) + 1, 0)
            const shared = beside ? stringWidth(beside) + 1 : 0
            const fitted = fitText(title, Math.max(1, rows - notice.rows), space.width() - 2 - counted - shared)
            // A grant's blank row between two lines is drawn only while it pushes none of them out.
            const free = space.rows() - space.gap() - notice.rows - fitted.used - lines
            return { notice, beside, title: fitted, gap: free >= granted.length - 1 ? 1 : 0 }
          }

          const questionBody = (granting: boolean, fitted: () => ReturnType<typeof layout>) => {
            const warnings = () => (links().lines.length > 1 || !fitted().notice.whole ? links().lines : [])
            // An edit's title is the names of its files. Any other is listed as it is, under its icon.
            const names = () => (fitted().title.cut ? (current.names ?? [title]) : [])
            const lead = current.names ? "Path: " : `${current.icon} `
            if (granting)
              return (
                <BodyScroll>
                  {/* The grant leads, and what is summed up or cut above follows it in the same scroll. */}
                  <box paddingLeft={1} gap={fitted().gap} flexShrink={0}>
                    <For each={permissionAlwaysLines(props.request)}>
                      {(line, index) => (
                        <Hanging
                          text={line}
                          fg={index() === 0 ? theme.text.muted : theme.text.base}
                          // The header is fitted to the grant's rows, which are counted by the character.
                          wrapMode="char"
                        />
                      )}
                    </For>
                  </box>
                  <Listed warnings={warnings()} names={names()} lead={lead} />
                </BodyScroll>
              )
            if (view() === "edit")
              return (
                <EditBody
                  file={current.file}
                  diff={current.diff}
                  diffs={current.diffs}
                  patch={current.patch}
                  warnings={warnings()}
                  names={names()}
                />
              )
            return (
              <BodyScroll>
                <Listed warnings={warnings()} />
                {view() === "external_directory" ? (
                  <Show when={current.lines.length > 0}>
                    <box paddingLeft={1} gap={1} flexShrink={0}>
                      <text fg={theme.text.muted} flexShrink={0}>
                        Patterns
                      </text>
                      <box flexShrink={0}>
                        <For each={current.lines}>{(line) => <Hanging text={line} fg={theme.text.base} />}</For>
                      </box>
                    </box>
                  </Show>
                ) : (
                  <box paddingLeft={1} flexShrink={0}>
                    <For each={current.lines}>
                      {(line) => (
                        <Hanging
                          text={line}
                          fg={
                            view() === "shell" || view() === "subagent" || view() === "task"
                              ? theme.text.base
                              : theme.text.muted
                          }
                        />
                      )}
                    </For>
                  </box>
                )}
                <Listed names={names()} lead={lead} />
              </BodyScroll>
            )
          }

          const changes = () =>
            (Array.isArray(props.request.metadata?.files) ? props.request.metadata.files : []).reduce(
              (total: { additions: number; deletions: number }, file) => {
                if (typeof file !== "object" || file === null || Array.isArray(file)) return total
                return {
                  additions: total.additions + (typeof file.additions === "number" ? file.additions : 0),
                  deletions: total.deletions + (typeof file.deletions === "number" ? file.deletions : 0),
                }
              },
              { additions: 0, deletions: 0 },
            )
          // The link warning is above the title, which names as many files as the request has, and outside the body,
          // which the focused option replaces.
          const header = (fitted: () => ReturnType<typeof layout>) => (
            <box flexDirection="column">
              <LinkNotice warning={fitted().notice.text} />
              <box flexDirection="row" gap={1} flexShrink={0} maxHeight={fitted().title.rows}>
                <text fg={theme.text.feedback.warning.base} flexShrink={0}>
                  {"▲"}
                </text>
                <Show when={fitted().beside}>
                  {(short) => (
                    <text fg={theme.text.feedback.warning.base} flexShrink={0}>
                      {short()}
                    </text>
                  )}
                </Show>
                {/* The title is measured in characters, so it is wrapped by them. */}
                <text fg={theme.text.base} flexShrink={1} wrapMode="char">
                  {fitted().title.text}
                </text>
                <Show when={changes().additions > 0}>
                  <text fg={theme.diff.text.added}>{`+${changes().additions}`}</text>
                </Show>
                <Show when={changes().deletions > 0}>
                  <text fg={theme.diff.text.removed}>{`−${changes().deletions}`}</text>
                </Show>
              </box>
            </box>
          )

          const body = (
            <SessionQuestion
              title="Permission required"
              semanticLabel={permissionSemanticLabel(props.request.action, current.title)}
              instance={props.request.id}
              header={(option, space) => header(() => layout(option === "always", space))}
              body={(option, space) => questionBody(option === "always", () => layout(option === "always", space))}
              options={
                props.request.save?.length
                  ? {
                      once: permissionOptionLabel("once"),
                      always: permissionOptionLabel("always"),
                      reject: permissionOptionLabel("reject"),
                    }
                  : { once: permissionOptionLabel("once"), reject: permissionOptionLabel("reject") }
              }
              escapeKey="reject"
              fullscreen
              onSelect={select}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

/**
 * Opens the request's diff in the linked editor when it can be reviewed there, as the reference does: a revisable Edit
 * or Write of one file that is not a notebook, while the bridge reviews diffs, `diffs.tool` is `auto` and the folder the
 * terminal UI started in is trusted. What the editor is sent is the request's own place, patch and status, and the
 * folders its session works in as the server names them now (classes 3 and 8). The editor's answer becomes the reply it
 * stands for, sent to the server like any other (class 12). Anything else keeps the question in the terminal, with one
 * log line (class 7). The editor and trust contexts are optional, so the prompt draws without them.
 */
function useEditorReview(request: PermissionRequest, location: () => { directory: string; workspaceID?: string } | undefined) {
  const editor = useContext(EditorContext)
  const trust = useContext(TrustContext)
  const client = useClient()
  const data = useData()
  const toast = useToast()
  const config = useConfig().data
  const log = useLog({ component: "permission" })
  const [open, setOpen] = createSignal(false)
  // Whether the editor still has a tab of this request that the terminal UI may need to close.
  let tab = false
  let tried = false
  let gone = false

  // Closes the editor's tab only: the question comes back to the full dialog only where it is asked here again.
  const close = () => {
    if (!tab) return
    tab = false
    editor?.diff.close(request.id)
  }

  const answer = (decision: PermissionReply, content?: string, closing = false) =>
    void data.session.permission
      .reply({ sessionID: request.sessionID, requestID: request.id, decision, content })
      .catch((error: unknown) => {
        // Refused: the question is still pending, and is asked here again.
        toast.error(error)
        setOpen(false)
      })
      .finally(() => closing && close())

  const handle = (event: EditorDiffEvent) => {
    if (event.answer === "saved") return answer("once", event.content, true)
    if (event.answer === "rejected") return answer("reject", undefined, true)
    tab = false
    // The person closed the tab: the proposal as it stands, once, as the reference takes it.
    if (event.answer === "closed") return answer("once")
    setOpen(false)
    if (event.answer === "dismissed") return log.warn("the editor closed the diff tab, so the question is asked here")
    if (event.answer === "unavailable")
      return log.warn("the editor could not open the diff, so the question is asked here", { reason: event.reason })
    log.warn("the link to the editor went away with the diff open, so the question is asked here")
  }

  const start = async () => {
    const file = reviewable(request)
    const where = location()
    if (!editor || !file || !where) return
    // The folders are read fresh for the session's own location, bounded as other reads at startup are.
    const found = await client.api.location
      .get({ location: where }, { signal: AbortSignal.timeout(2_000) })
      .catch((error: unknown) => {
        log.warn("could not read the session's folders for the diff, so the question is asked here", { error })
        return undefined
      })
    if (!found || gone) return
    const review: EditorDiff = {
      id: request.id,
      ...file,
      roots: [...new Set([found.directory, found.project.directory])],
    }
    if (!editor.diff.open(review, handle))
      return log.warn("the diff was not sent to the editor, so the question is asked here")
    tab = true
    setOpen(true)
  }

  createEffect(
    on(
      () =>
        editor?.diff.available() === true &&
        trust?.startup.trusted() === true &&
        (config.diffs?.tool ?? "auto") === "auto" &&
        location() !== undefined,
      (ready) => {
        if (!ready || tried) return
        tried = true
        void start()
      },
    ),
  )
  onCleanup(() => {
    gone = true
    close()
  })

  return { open, close, ask: () => setOpen(false), editor: () => editor?.server()?.name ?? "the editor" }
}

// The file of a request that can be reviewed in the editor: the one file of a revisable request, with an absolute place,
// a patch and a status, and not a notebook, whose diff is JSON.
function reviewable(request: PermissionRequest): Omit<EditorDiff, "id" | "roots"> | undefined {
  const files = request.metadata?.files
  if (request.revisable !== true || !Array.isArray(files) || files.length !== 1) return undefined
  const file = files[0]
  if (!isRecord(file) || typeof file.place !== "string" || typeof file.patch !== "string") return undefined
  if (!/^(\/|[A-Za-z]:[\\/])/.test(file.place) || /\.ipynb$/i.test(file.place)) return undefined
  const status = file.status === "added" ? "added" : file.status === "modified" ? "modified" : undefined
  if (!status) return undefined
  return { place: file.place, patch: file.patch, status }
}

// The line about the request's links that never scrolls away. It wraps by the character, as `fitLinks` measures it.
function LinkNotice(props: { warning?: string }) {
  const theme = useTheme()
  return (
    <Show when={props.warning}>
      {(line) => <Hanging text={line()} fg={theme.text.feedback.warning.base} wrapMode="char" />}
    </Show>
  )
}

// The fixed line of a request's links in `rows` rows at most: one link's whole warning where it fits, and otherwise the
// summary, in its short form where the sentence is wider than the line.
function fitLinks(links: ReturnType<typeof permissionLinks>, rows: number, width: number) {
  if (!links.summary) return { text: undefined, rows: 0, whole: true }
  const line = links.lines.length === 1 ? links.lines[0] : undefined
  const taken = line === undefined ? Infinity : wrappedRows(line, width)
  if (taken <= rows) return { text: line, rows: taken, whole: true }
  return { text: stringWidth(links.summary) <= width ? links.summary : links.short, rows: 1, whole: false }
}

// `text` in `rows` rows of `width` at most, with a mark where it is cut, and the rows that it then takes.
function fitText(text: string, rows: number, width: number) {
  const each = Math.max(1, width - 1)
  const room = rows * each
  if (stringWidth(text) <= room) return { text, rows, used: Math.max(1, Math.ceil(stringWidth(text) / each)), cut: false }
  return { text: Locale.truncateWidth(text, room), rows, used: rows, cut: true }
}

// How many rows `Hanging` takes to draw `line` wrapped by the character, for each line that it has. A cell is left over
// on each row, for a character of two cells that does not fit in the last one.
function wrappedRows(line: string, width: number) {
  const lead = hangingLead(line)
  const each = Math.max(1, width - lead.length - 1)
  return line
    .slice(lead.length)
    .split("\n")
    .reduce((total, row) => total + Math.max(1, Math.ceil(stringWidth(row) / each)), 0)
}

/**
 * The short prompt while the request's diff is open in the editor: where it opened, the link warning, and the question
 * about the file by its name, with the usual options. The diff itself is in the editor, so none is drawn here. Every name
 * is written out, since the editor and the repository chose them (class 9). Neither a warning nor a name takes the rows
 * of what Always allow grants: a warning too long for its rows is summed up, a name is cut, and both are whole in what
 * scrolls, under the grant.
 */
export function EditorDiffPrompt(props: {
  request: PermissionRequest
  editor: string
  onSelect: (option: string) => void
}) {
  const theme = useTheme()
  const pathFormatter = usePathFormatter()
  const name = () => {
    const files = props.request.metadata?.files
    const file = Array.isArray(files) && isRecord(files[0]) ? files[0] : undefined
    const place = typeof file?.place === "string" ? file.place : (props.request.resources[0] ?? "")
    return plainPath(place.split(/[\\/]/).at(-1) ?? place)
  }
  // It is only drawn for a request of one file, which has one linked end at most.
  const links = createMemo(() => permissionLinks(props.request, pathFormatter.format))
  const vscode = process.env.TERM_PROGRAM === "vscode"
  const layout = (granting: boolean, space: Space) => {
    const granted = granting
      ? permissionAlwaysLines(props.request).reduce((total, line) => total + wrappedRows(line, space.width()), 0)
      : 0
    // Under the one row of the header and the gap. The row about saving gives way to the question and the grant.
    const under = space.rows() - 1 - space.gap()
    const saves = vscode && under >= 3
    const free = under - (saves ? 1 : 0)
    const beside = links().summary && free < 3 ? links().short : undefined
    const notice = beside
      ? { text: undefined, rows: 0, whole: false }
      : fitLinks(links(), Math.min(3, Math.max(1, free - granted - 1)), space.width())
    const left = free - notice.rows - granted
    const asked = `Make this change to ${name()}?`
    const width = space.width() - (beside ? stringWidth(beside) + 1 : hangingLead(asked).length)
    // What is summed up or cut leaves rows to read the whole of it in.
    const reserved = granting ? 0 : BODY_ROWS
    const whole = fitText(asked, Math.max(1, left - (notice.whole ? 0 : reserved)), width)
    const question = whole.cut ? fitText(asked, Math.max(1, left - reserved), width) : whole
    return { notice, beside, saves, question }
  }
  return (
    <SessionQuestion
      title="Permission required"
      semanticLabel={permissionSemanticLabel(props.request.action, `Edit ${name()}`)}
      instance={props.request.id}
      header={
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.text.feedback.warning.base}>{"▲"}</text>
          {/* The layout counts one row for it, and one for saving: each is cut in the middle rather than wrapped. */}
          <text fg={theme.text.base} flexShrink={1} height={1} wrapMode="none" truncate>
            {`Reviewing in ${plain(props.editor)}`}
          </text>
        </box>
      }
      // While Always allow is focused the prompt says what it grants, as the full dialog does, so the short prompt never
      // hides that the grant reaches past this one file.
      body={(option, space) => {
        const fitted = () => layout(option === "always", space)
        return (
          <box flexDirection="column" flexShrink={1}>
            <box paddingLeft={1} flexDirection="column" flexShrink={0}>
              <LinkNotice warning={fitted().notice.text} />
              <Show when={fitted().saves}>
                <text fg={theme.text.muted} flexShrink={0} height={1} wrapMode="none" truncate>
                  Save in the editor to answer
                </text>
              </Show>
              <Show
                when={fitted().beside}
                fallback={<Hanging text={fitted().question.text} fg={theme.text.base} wrapMode="char" />}
              >
                {(short) => (
                  <box flexDirection="row" gap={1} flexShrink={0} maxHeight={1}>
                    <text fg={theme.text.feedback.warning.base} flexShrink={0}>
                      {short()}
                    </text>
                    <text fg={theme.text.base} flexShrink={1} wrapMode="char">
                      {fitted().question.text}
                    </text>
                  </box>
                )}
              </Show>
            </box>
            <BodyScroll>
              <Show when={option === "always"}>
                <box paddingLeft={1} flexDirection="column" flexShrink={0}>
                  <For each={permissionAlwaysLines(props.request)}>
                    {(line, index) => (
                      <Hanging text={line} fg={index() === 0 ? theme.text.muted : theme.text.base} wrapMode="char" />
                    )}
                  </For>
                </box>
              </Show>
              <Listed
                warnings={fitted().notice.whole ? [] : links().lines}
                names={fitted().question.cut ? [name()] : []}
                lead="Path: "
              />
            </BodyScroll>
          </box>
        )
      }}
      options={
        props.request.save?.length
          ? {
              once: permissionOptionLabel("once"),
              always: permissionOptionLabel("always"),
              reject: permissionOptionLabel("reject"),
            }
          : { once: permissionOptionLabel("once"), reject: permissionOptionLabel("reject") }
      }
      escapeKey="reject"
      onSelect={props.onSelect}
    />
  )
}

export function permissionSemanticLabel(action: string, title?: string) {
  return `Permission required: ${title ?? action}`
}

function RejectPrompt(props: {
  action: string
  instance: string
  links: ReturnType<typeof permissionLinks>
  onConfirm: (message: string) => void
  onCancel: () => void
}) {
  let input: TextareaRenderable
  const enabled = useInteractivity()
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  const [width, setWidth] = createSignal(dimensions().width)
  Keymap.createLayer(() => ({
    context: "permission",
    mode: "base",
    commands: [
      {
        id: "app.exit",
        title: "Cancel permission rejection",
        group: "Permission",
        run(_input, event) {
          if (event?.ctrl && event.name === "c" && input.plainText) {
            input.setText("")
            return
          }
          props.onCancel()
        },
      },
      { bind: "escape", title: "Cancel permission rejection", group: "Permission", run: () => props.onCancel() },
      {
        bind: "return",
        title: "Confirm permission rejection",
        group: "Permission",
        run: () => props.onConfirm(input.plainText),
      },
    ],
  }))

  return (
    <box
      id="session.permission.reject"
      ref={SimulationSemantics.bind(() => ({
        instance: props.instance,
        role: "dialog",
        label: `Reject permission: ${props.action}`,
      }))}
      onSizeChange={function () {
        setWidth(this.width)
      }}
      backgroundColor={theme.background.raised.base}
      border={["left"]}
      borderColor={theme.text.feedback.error.base}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="column" paddingLeft={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.feedback.error.base}>{"△"}</text>
            <text fg={theme.text.base}>Reject permission</text>
          </box>
          {/* The field under it has no room to scroll: a warning of more than three rows is summed up. */}
          <LinkNotice warning={fitLinks(props.links, 3, width() - 6).text} />
        </box>
        <box paddingLeft={1}>
          <text fg={theme.text.muted}>Tell Orbit what to do differently</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.decrease(theme.background.raised.base)}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <textarea
          id="session.permission.reject.message"
          ref={(val: TextareaRenderable) => {
            input = val
            SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "textbox",
              label: "Rejection reason",
              focused: val.focused,
              disabled: false,
            }))(val)
            val.traits = { status: "REJECT" }
          }}
          focused={enabled()}
          textColor={theme.text.base}
          focusedTextColor={theme.text.base}
          cursorColor={theme.text.base}
          cursorStyle={config.cursor}
        />
        <box
          id="session.permission.reject.actions"
          ref={SimulationSemantics.bind(() => ({
            instance: props.instance,
            role: "group",
            label: "Rejection actions",
          }))}
          flexDirection="row"
          gap={2}
          flexShrink={0}
        >
          <box
            id="session.permission.reject.confirm"
            ref={SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "button",
              label: "Confirm rejection",
              disabled: false,
            }))}
            onMouseUp={() => props.onConfirm(input.plainText)}
          >
            <text fg={theme.text.base}>
              enter <span style={{ fg: theme.text.muted }}>confirm</span>
            </text>
          </box>
          <box
            id="session.permission.reject.cancel"
            ref={SimulationSemantics.bind(() => ({
              instance: props.instance,
              role: "button",
              label: "Cancel rejection",
              disabled: false,
            }))}
            onMouseUp={props.onCancel}
          >
            <text fg={theme.text.base}>
              esc <span style={{ fg: theme.text.muted }}>cancel</span>
            </text>
          </box>
        </box>
      </box>
    </box>
  )
}

export function SessionQuestion<const T extends Record<string, string>>(props: {
  title: string
  semanticLabel?: string
  instance: string
  id?: string
  group?: string
  choicesLabel?: string
  header?: JSX.Element | ((option: keyof T, space: Space) => JSX.Element)
  body: JSX.Element | ((option: keyof T, space: Space) => JSX.Element)
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const narrow = createMemo(() => dimensions().width < 80)
  const shortcuts = Keymap.useShortcuts()
  const id = () => props.id ?? "session.permission"
  const group = () => props.group ?? "Permission"
  const dismiss = () => {
    if (store.expanded) {
      setStore("expanded", false)
      return
    }
    if (props.escapeKey) props.onSelect(props.escapeKey)
  }

  Keymap.createLayer(() => ({
    context: "permission",
    mode: "base",
    commands: [
      ...(props.escapeKey
        ? [
            {
              id: "app.exit",
              title: "Reject permission",
              group: group(),
              bind: false as const,
              run: dismiss,
            },
          ]
        : []),
      ...(props.fullscreen
        ? [
            {
              id: "permission.prompt.fullscreen",
              title: "Toggle permission fullscreen",
              group: group(),
              bind: false as const,
              run: () => setStore("expanded", (value) => !value),
            },
          ]
        : []),
      // Digits pick an option directly, as the numbers beside them show.
      ...keys.slice(0, 9).map((option, index) => ({
        bind: String(index + 1),
        title: `Select ${props.options[option]}`,
        group: group(),
        run: () => props.onSelect(option),
      })),
      ...(keys.length > 1
        ? [
            {
              bind: "left,h,up,k",
              title: "Previous option",
              group: group(),
              run: () => {
                const index = keys.indexOf(store.selected)
                setStore("selected", keys[(index - 1 + keys.length) % keys.length])
              },
            },
            {
              bind: "right,l,down,j",
              title: "Next option",
              group: group(),
              run: () => {
                const index = keys.indexOf(store.selected)
                setStore("selected", keys[(index + 1) % keys.length])
              },
            },
          ]
        : []),
      {
        bind: "return",
        title: "Select option",
        group: group(),
        run: () => props.onSelect(store.selected),
      },
      ...(props.escapeKey ? [{ bind: "escape", title: "Reject permission", group: group(), run: dismiss }] : []),
    ],
    bindings: [...(props.escapeKey ? ["app.exit"] : []), ...(props.fullscreen ? ["permission.prompt.fullscreen"] : [])],
  }))

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))
  useRenderer()
  // The dialog can be narrower than the screen, beside a sidebar, so it measures itself.
  const [width, setWidth] = createSignal(dimensions().width)
  // What the border and the options leave of the dialog, for the question and for the hints, stacked on a narrow screen.
  const room = createMemo(() => {
    const height = store.expanded ? dimensions().height - 2 : Math.min(DIALOG_ROWS, dimensions().height)
    const hints = narrow() ? (keys.length > 1 ? 1 : 0) + 2 + (props.fullscreen ? 1 : 0) : 1
    const all = height - 2 - keys.length
    // The hints give way on a screen too low for them beside a row of the header, one of the question and the grant's.
    const hinted = all - hints >= 3
    return { hinted, rows: hinted ? all - hints : all }
  })
  const space: Space = {
    rows: () => room().rows,
    // The blank row under the header gives way where the question has three rows or fewer.
    gap: () => (room().rows < 4 ? 0 : 1),
    // Less the border and the padding on both sides.
    width: () => width() - 6,
  }

  const content = () => (
    <box
      id={id()}
      onSizeChange={function () {
        setWidth(this.width)
      }}
      ref={SimulationSemantics.bind(() => ({
        instance: props.instance,
        role: "dialog",
        label: props.semanticLabel ?? props.title,
        expanded: store.expanded,
      }))}
      backgroundColor={theme.background.base}
      border
      borderStyle="rounded"
      borderColor={theme.text.feedback.warning.base}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: DIALOG_ROWS,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      {/* What does not fit is clipped here, so nothing is painted over the options, the hints or the border. */}
      <box gap={space.gap()} paddingLeft={1} paddingRight={2} flexGrow={1} overflow="hidden">
        <Show
          when={props.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={theme.text.feedback.warning.base}>{"▲"}</text>
              <text fg={theme.text.base}>{props.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {typeof props.header === "function" ? props.header(store.selected, space) : props.header}
          </box>
        </Show>
        {typeof props.body === "function" ? props.body(store.selected, space) : props.body}
      </box>
      <box flexShrink={0} paddingLeft={2} paddingRight={2}>
        <box
          id={`${id()}.actions`}
          ref={SimulationSemantics.bind(() => ({
            instance: props.instance,
            role: "listbox",
            label: props.choicesLabel ?? "Permission choices",
          }))}
          flexShrink={0}
        >
          <For each={keys}>
            {(option, index) => (
              <box
                id={`${id()}.action.${String(option)}`}
                ref={SimulationSemantics.bind(() => ({
                  instance: props.instance,
                  role: "option",
                  label: props.options[option],
                  focused: option === store.selected,
                  selected: option === store.selected,
                  disabled: false,
                }))}
                flexDirection="row"
                gap={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.background.raised.high : theme.background.base}
                onMouseMove={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text fg={theme.text.feedback.warning.base} width={1} flexShrink={0}>
                  {option === store.selected ? "›" : " "}
                </text>
                <text fg={theme.text.muted} flexShrink={0}>
                  {index() < 9 ? String(index() + 1) : " "}
                </text>
                <text fg={theme.text.base}>{props.options[option]}</text>
              </box>
            )}
          </For>
        </box>
        <Show when={room().hinted}>
          <box flexDirection={narrow() ? "column" : "row"} gap={narrow() ? 0 : 2} flexShrink={0}>
            <Show when={keys.length > 1}>
              <text fg={theme.text.muted}>↑↓ select</text>
            </Show>
            <text fg={theme.text.muted}>enter confirm</text>
            <text fg={theme.text.muted}>{keys.length > 1 ? `1–${Math.min(keys.length, 9)} shortcut` : "1 shortcut"}</text>
            <Show when={props.fullscreen}>
              <text fg={theme.text.muted}>
                {shortcuts.get("permission.prompt.fullscreen")} {hint()}
              </text>
            </Show>
          </box>
        </Show>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
