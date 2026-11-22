import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, useContext } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { BorderSides, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
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
 * The room a question has in its dialog: `rows` for the header and the body, above the options and the hints and beside
 * the blank row between them, and `width` for a line of either. `scrolls` is told whether the body holds more than is
 * in sight.
 */
type Space = { rows: () => number; width: () => number; scrolls: (value: boolean) => void }
/**
 * The rows of a header and a body at which a question has more of itself in sight: `whole` with a warning of several
 * rows whole, which the blank row gives way to on any screen, and `more` with that or more, which the hints and the
 * blank row give way to on a low or narrow one.
 */
type Wants = { whole: number; more: number[] }
// What a name must not say on the fixed line of a warning.
const WARNING_WORDS = /link ends|linked paths/i
// The rows that the scrolling body of an edit keeps under a title too long to be said whole.
const BODY_ROWS = 2
/** The rows of an approval's dialog at most, where the screen has them. */
export const DIALOG_ROWS = 15
// Under this width a line of a question wraps so often that the hints give way to it, as on a low screen.
const NARROW = 60

function EditBody(props: {
  file?: string
  diff?: string
  diffs?: { file: string; diff: string }[]
  patch?: string
  /** The warning of each link that the fixed line does not say whole: they lead what scrolls. */
  warnings: string[]
  /** The names that a cut title no longer shows whole. */
  names: string[]
  space: Space
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
    <BodyScroll space={props.space} fill={diffs().length > 0 || Boolean(props.patch)}>
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
function BodyScroll(props: { children: JSX.Element; space: Space; fill?: boolean }) {
  const theme = useTheme()
  const config = useConfig().data
  let scroll: ScrollBoxRenderable | undefined
  const [shown, setShown] = createSignal(0)
  const [held, setHeld] = createSignal(0)
  const overflows = createMemo(() => held() > shown())
  // The next body says it again for itself, as the focused option replaces this one.
  createEffect(() => props.space.scrolls(overflows()))
  // A step keeps a row of what the body showed, which can be two: no row, and no name across two, is skipped. A body of
  // one row moves by that row.
  const page = () => Math.max(1, (scroll?.viewport.height ?? 1) - 1)
  // While there is more than is in sight these keys are the question's, over the session's of the same keys under it: a
  // person without a mouse reads all that Enter approves (class 8).
  Keymap.createLayer(() => ({
    context: "permission",
    mode: "base",
    priority: 1,
    enabled: overflows(),
    commands: [
      {
        id: "permission.prompt.page.up",
        title: "Scroll the question up",
        group: "Permission",
        run: () => scroll?.scrollBy(-page()),
      },
      {
        id: "permission.prompt.page.down",
        title: "Scroll the question down",
        group: "Permission",
        run: () => scroll?.scrollBy(page()),
      },
      {
        id: "permission.prompt.first",
        title: "Scroll to the start of the question",
        group: "Permission",
        run: () => scroll?.scrollTo(0),
      },
      {
        id: "permission.prompt.last",
        title: "Scroll to the end of the question",
        group: "Permission",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
    ],
  }))
  const scrollAcceleration = createMemo(() => {
    const base = getScrollAcceleration(config)
    return {
      tick: (now?: number) => Math.min(base.tick(now), page()),
      reset: () => base.reset(),
    }
  })
  return (
    <scrollbox
      flexShrink={1}
      onSizeChange={function () {
        setShown(this.height)
      }}
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
      {/* The scroll box measures its own content for the bar, so what it holds is measured in a box of its own. */}
      <box
        flexDirection="column"
        flexShrink={0}
        onSizeChange={function () {
          setHeld(this.height)
        }}
      >
        {props.children}
      </box>
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

export function PermissionPrompt(props: {
  request: PermissionRequest
  directory?: string
  /** The rows there are for the question, where that is less than the screen. */
  rows?: number
}) {
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
        <EditorDiffPrompt request={props.request} editor={review.editor()} rows={props.rows} onSelect={select} />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          action={props.request.action}
          instance={props.request.id}
          links={links()}
          rows={props.rows}
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
          // What a title can be wide, beside its icon and the counts.
          const titleWidth = (width: number) =>
            [changes().additions, changes().deletions]
              .filter((count) => count > 0)
              .reduce((left, count) => left - stringWidth(`+${count}`) - 1, width - 2)
          const grantRows = (granting: boolean, width: number) =>
            (granting ? permissionAlwaysLines(props.request) : []).reduce(
              (total, line) => total + wrappedRows(line, width),
              0,
            )
          // What the question would have in sight, for the rows that give way to it: the whole warning, the title and
          // what the body keeps, the same with a title of one row, and the whole title under the summary.
          const wants = (granting: boolean, width: number) => {
            const warning = linkRows(links(), width)
            const body = Math.max(1, grantRows(granting, width))
            const named = fitText(title, Infinity, titleWidth(width)).used
            return {
              whole: warning > 1 ? warning + 1 + body : 0,
              more: [warning + named + body, warning + 1 + body, Math.min(1, warning) + named + body],
            }
          }
          // How the header is fitted (class 8): one link is said whole while that leaves a row to the title and one to
          // what a person approves, which is all of the grant while Always allow is focused. The title is whole while it
          // leaves the same, and is otherwise cut to leave an edit two rows to scroll in. Where the dialog has no row for
          // both, the short summary shares the title's. What is cut or summed up is whole in the body, whichever option
          // is focused.
          const layout = (granting: boolean, space: Space) => {
            const granted = granting ? permissionAlwaysLines(props.request) : []
            const lines = grantRows(granting, space.width())
            const least = granting ? lines : 1
            const beside = links().summary && space.rows() < 3 ? links().short : undefined
            const notice = beside
              ? { text: undefined, rows: 0, whole: false }
              : fitLinks(links(), Math.max(1, space.rows() - 1 - least), space.width())
            const left = space.rows() - notice.rows
            const width = titleWidth(space.width()) - (beside ? stringWidth(beside) + 1 : 0)
            const whole = fitText(title, Math.max(1, left - least), width)
            const kept = !granting && view() === "edit" ? BODY_ROWS : least
            const fitted = whole.cut ? fitText(title, Math.max(1, left - kept), width) : whole
            // A grant's blank row between two lines is drawn only while it pushes none of them out.
            const free = left - fitted.used - lines
            return { notice, beside, title: fitted, gap: free >= granted.length - 1 ? 1 : 0 }
          }

          const questionBody = (granting: boolean, space: Space, fitted: () => ReturnType<typeof layout>) => {
            const warnings = () => (links().lines.length > 1 || !fitted().notice.whole ? links().lines : [])
            // An edit's title is the names of its files. Any other is listed as it is, under its icon. A name that the
            // whole warning says is not listed again over the diff that it would push out of sight.
            const names = () => {
              if (!fitted().title.cut) return []
              const said = fitted().notice.whole ? links().named : []
              return (current.names ?? [title]).filter((name) => !said.includes(name))
            }
            const lead = current.names ? "Path: " : `${current.icon} `
            if (granting)
              return (
                <BodyScroll space={space}>
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
                  space={space}
                />
              )
            return (
              <BodyScroll space={space}>
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
              rows={props.rows}
              wants={(option, width) => wants(option === "always", width)}
              header={(option, space) => header(() => layout(option === "always", space))}
              body={(option, space) => questionBody(option === "always", space, () => layout(option === "always", space))}
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
  const line = fixedLine(links)
  const taken = line === undefined ? Infinity : wrappedRows(line, width)
  if (taken <= rows) return { text: line, rows: taken, whole: true }
  return { text: stringWidth(links.summary) <= width ? links.summary : links.short, rows: 1, whole: false }
}

// The rows of a request's fixed line where it says all that it can: one link's whole warning, or the summary.
function linkRows(links: ReturnType<typeof permissionLinks>, width: number) {
  if (!links.summary) return 0
  const line = fixedLine(links)
  return line === undefined ? 1 : wrappedRows(line, width)
}

// The warning that the fixed line can say whole: one link's, with no warning's words in what the repository named, which
// a wrap could put at the start of a row of the line that is Orbit's own (class 9).
function fixedLine(links: ReturnType<typeof permissionLinks>) {
  if (links.lines.length !== 1) return undefined
  const line = links.lines[0]!
  return WARNING_WORDS.test(line.slice(hangingLead(line).length)) ? undefined : line
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
  /** The rows there are for the question, where that is less than the screen. */
  rows?: number
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
  // The header gives way where it would leave the question no row to scroll in.
  const headed = (space: Space) => space.rows() >= 3
  const asked = () => `Make this change to ${name()}?`
  const askedWidth = (width: number) => width - hangingLead(asked()).length
  const measured = (granting: boolean, width: number) => {
    const granted = granting
      ? permissionAlwaysLines(props.request).reduce((total, line) => total + wrappedRows(line, width), 0)
      : 0
    const warning = linkRows(links(), width)
    const question = fitText(asked(), Infinity, askedWidth(width)).used
    return { granted, warning, question, all: warning + question + granted }
  }
  // With the header's row: all of it, the whole warning over a question of one row, and the whole question under the
  // summary, with a row to read the rest in.
  const wants = (granting: boolean, width: number) => {
    const { granted, warning, question, all } = measured(granting, width)
    const summed = Math.min(1, warning)
    const whole = 1 + warning + 1 + granted
    return {
      whole: warning > 1 ? whole : 0,
      more: [1 + all, whole, 1 + summed + question + Math.max(summed, granted)],
    }
  }
  const layout = (granting: boolean, space: Space) => {
    const { granted, warning, all } = measured(granting, space.width())
    // Under the one row of the header, where that is drawn. The row about saving is the first to give way: it is drawn
    // only over the whole warning, question and grant.
    const under = space.rows() - (headed(space) ? 1 : 0)
    const saves = vscode && under > all
    const free = under - (saves ? 1 : 0)
    const said = fixedLine(links()) !== undefined && warning + 1 + granted <= free
    const beside = links().summary && free < 3 && !said ? links().short : undefined
    if (beside) {
      const question = fitText(asked(), 1, space.width() - stringWidth(beside) - 1)
      return { notice: { text: undefined, rows: 0, whole: false }, beside, saves, question }
    }
    const notice = fitLinks(links(), Math.max(1, free - 1 - granted), space.width())
    const left = free - notice.rows - granted
    const width = askedWidth(space.width())
    // The question is whole where it leaves a row for what was summed up, and is otherwise cut to leave rows to read in.
    const whole = fitText(asked(), Math.max(1, left - (granting || notice.whole ? 0 : 1)), width)
    // A name is in the whole of its link's warning: without one, a cut question leaves rows to read it in.
    const kept = granting ? 0 : notice.whole ? (warning ? 0 : 1) : BODY_ROWS
    const question = whole.cut ? fitText(asked(), Math.max(1, left - kept), width) : whole
    return { notice, beside, saves, question }
  }
  return (
    <SessionQuestion
      title="Permission required"
      semanticLabel={permissionSemanticLabel(props.request.action, `Edit ${name()}`)}
      instance={props.request.id}
      rows={props.rows}
      wants={(option, width) => wants(option === "always", width)}
      header={(_, space) => (
        <Show when={headed(space)}>
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text fg={theme.text.feedback.warning.base}>{"▲"}</text>
            {/* The layout counts one row for it, and one for saving: each is cut in the middle rather than wrapped. */}
            <text fg={theme.text.base} flexShrink={1} height={1} wrapMode="none" truncate>
              {`Reviewing in ${plain(props.editor)}`}
            </text>
          </box>
        </Show>
      )}
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
            <BodyScroll space={space}>
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
                names={fitted().question.cut && !(links().summary && fitted().notice.whole) ? [name()] : []}
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

const TELL = "Tell Orbit what to do differently"

function RejectPrompt(props: {
  action: string
  instance: string
  links: ReturnType<typeof permissionLinks>
  rows?: number
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
  // Beside the border and the padding. The blank rows give way where there are too few for them, and the warning is
  // summed up, so that the field and the hints stay on screen.
  const fitted = createMemo(() => {
    const rows = props.rows ?? dimensions().height
    const inner = width() - 6
    // The field's row, and on a narrow screen the hints' under it.
    const answer = narrow() ? 2 : 1
    const notice = fitLinks(props.links, 3, inner)
    // Five blank rows, and one more between the field and hints that are stacked.
    const blanks = narrow() ? 6 : 5
    const full = 1 + notice.rows + wrappedRows(TELL, inner) + answer + blanks
    if (full <= rows) return { notice, roomy: true, field: rows - full + 1 }
    const low = fitLinks(props.links, Math.max(1, Math.min(3, rows - 2 - answer)), inner)
    return { notice: low, roomy: false, field: Math.max(1, rows - 2 - low.rows - answer + 1) }
  })
  const blank = () => (fitted().roomy ? 1 : 0)
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
      flexShrink={0}
      backgroundColor={theme.background.raised.base}
      border={["left"]}
      borderColor={theme.text.feedback.error.base}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={blank()} paddingLeft={1} paddingRight={3} paddingTop={blank()} paddingBottom={blank()} flexShrink={0}>
        <box flexDirection="column" paddingLeft={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text.feedback.error.base}>{"△"}</text>
            <text fg={theme.text.base}>Reject permission</text>
          </box>
          {/* The field under it has no room to scroll: a warning of more than three rows is summed up. */}
          <LinkNotice warning={fitted().notice.text} />
        </box>
        <box paddingLeft={1}>
          <text fg={theme.text.muted} maxHeight={fitted().roomy ? undefined : 1}>
            {TELL}
          </text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={blank()}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={blank()}
        backgroundColor={theme.decrease(theme.background.raised.base)}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={narrow() ? blank() : 1}
      >
        <textarea
          id="session.permission.reject.message"
          maxHeight={fitted().field}
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
  /** The rows there are for the dialog, where that is less than the screen. */
  rows?: number
  wants?: (option: keyof T, width: number) => Wants
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
  const [scrolls, setScrolls] = createSignal(false)
  // Fullscreen keeps a row of the screen above and below it, where that leaves two to the header and the body.
  const inset = () => (dimensions().height - 2 < keys.length + 2 ? 0 : 1)
  const room = createMemo(() => {
    const height = store.expanded
      ? dimensions().height - 2 * inset()
      : Math.min(DIALOG_ROWS, props.rows ?? dimensions().height)
    // Every option is in the dialog, with a row of the header and one of the body above them: the border's top gives
    // way to those first, and then its bottom, which names the keys that scroll.
    const top = height - 2 - keys.length >= 2
    const bottom = height - 1 - keys.length >= 2
    const all = height - (top ? 1 : 0) - (bottom ? 1 : 0) - keys.length
    const hints = narrow() ? (keys.length > 1 ? 1 : 0) + 2 + (props.fullscreen ? 1 : 0) : 1
    const wants = props.wants?.(store.selected, width() - 6) ?? { whole: 0, more: [] }
    const tight = width() < NARROW || height < DIALOG_ROWS
    // Whether rows that give way put more of the question in sight, which only a low or a narrow screen needs.
    const buys = (without: number, rows: number) => tight && wants.more.some((want) => want > without && want <= rows)
    // The hints give way on a screen too low for them beside a row of the header, one of the question and the grant's,
    // and on a low or narrow one to what they would push out of sight.
    const hinted = all - hints >= 3 && !buys(all - hints, all)
    const rows = hinted ? all - hints : all
    // The blank row under the header gives way first: to a warning that is whole without it on any screen, and always
    // where the question has three rows or fewer.
    const gap = rows < 4 || wants.whole === rows || buys(rows - 1, rows) ? 0 : 1
    return { height, top, bottom, hinted, gap, rows: rows - gap }
  })
  const space: Space = {
    rows: () => room().rows,
    // Less the border and the padding on both sides.
    width: () => width() - 6,
    scrolls: setScrolls,
  }
  const sides = createMemo(() => {
    if (room().top) return true
    const open: BorderSides[] = room().bottom ? ["left", "right", "bottom"] : ["left", "right"]
    return open
  })
  // Said on the border, so it takes no row of what it scrolls.
  const scrollKeys = () => {
    if (!scrolls()) return undefined
    const keys = [shortcuts.get("permission.prompt.page.up"), shortcuts.get("permission.prompt.page.down")]
      .filter((key) => key)
      .join("/")
    return keys ? ` ${keys} scroll ` : undefined
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
      border={sides()}
      borderStyle="rounded"
      borderColor={theme.text.feedback.warning.base}
      bottomTitle={scrollKeys()}
      bottomTitleAlignment="right"
      flexShrink={0}
      {...(store.expanded
        ? { top: dimensions().height * -1 + inset(), bottom: inset(), left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: room().height,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      {/* What does not fit is clipped here, so nothing is painted over the options, the hints or the border. */}
      <box gap={room().gap} paddingLeft={1} paddingRight={2} flexGrow={1} flexShrink={1} overflow="hidden">
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
