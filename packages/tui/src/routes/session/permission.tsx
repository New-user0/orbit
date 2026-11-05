import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, useContext } from "solid-js"
import { Portal, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { plain } from "@orbit/util/plain"
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
import { permissionAlwaysLines, permissionOptionLabel, permissionPresentation } from "../../util/permission"
import { getScrollAcceleration } from "../../util/scroll"
import { useConfig } from "../../config"
import { Keymap } from "../../context/keymap"
import { useInteractivity } from "../../context/interactivity"
import { usePathFormatter } from "../../context/path-format"
import { SimulationSemantics } from "../../simulation/semantics"
import { PatchDiff } from "../../component/patch-diff"
import { useToast } from "../../ui/toast"

type PermissionStage = "permission" | "reject"

function EditBody(props: {
  file?: string
  diff?: string
  diffs?: { file: string; diff: string }[]
  patch?: string
  /** Where a link on the way leads, from the request. */
  warning?: string
}) {
  const theme = useTheme()
  const themes = useThemes()
  const syntax = themes.currentSyntax
  const config = useConfig().data
  const dimensions = useTerminalDimensions()

  // A patch that edits several files gets one diff per file, each under its own path.
  const diffs = createMemo(() => props.diffs ?? (props.diff ? [{ file: props.file ?? "", diff: props.diff }] : []))
  const several = () => diffs().length > 1

  const view = createMemo(() => {
    const diffView = config.diffs?.view
    if (diffView === "unified") return "unified"
    if (diffView === "split") return "split"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={props.warning}>
        {(warning) => (
          <box paddingLeft={1} flexShrink={0}>
            <text fg={theme.text.feedback.warning.base}>{warning()}</text>
          </box>
        )}
      </Show>
      <Show when={diffs().length > 0}>
        <scrollbox
          height="100%"
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background.base,
              foregroundColor: theme.scrollbar.base,
            },
          }}
        >
          <box flexDirection="column" gap={1}>
            <For each={diffs()}>
              {(item) => (
                <box flexDirection="column">
                  <Show when={several()}>
                    <box paddingLeft={1}>
                      <text fg={theme.text.muted}>{`Path: ${item.file}`}</text>
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
          </box>
        </scrollbox>
      </Show>
      <Show when={diffs().length === 0}>
        <Show
          when={props.patch}
          fallback={
            <box paddingLeft={1}>
              <text fg={theme.text.muted}>No diff provided</text>
            </box>
          }
        >
          {(patch) => (
            <scrollbox
              height="100%"
              scrollAcceleration={scrollAcceleration()}
              verticalScrollbarOptions={{
                trackOptions: {
                  backgroundColor: theme.background.base,
                  foregroundColor: theme.scrollbar.base,
                },
              }}
            >
              <code
                filetype="diff"
                drawUnstyledText={false}
                streaming={true}
                syntaxStyle={syntax()}
                content={patch()}
                fg={theme.text.muted}
              />
            </scrollbox>
          )}
        </Show>
      </Show>
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
          const presentationBody = () =>
            view() === "edit" ? (
              <EditBody
                file={current.file}
                diff={current.diff}
                diffs={current.diffs}
                patch={current.patch}
                warning={linkWarning(props.request, pathFormatter.format)}
              />
            ) : view() === "external_directory" ? (
              <Show when={current.lines.length > 0}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.text.muted}>Patterns</text>
                  <box>
                    <For each={current.lines}>{(line) => <text fg={theme.text.base}>{line}</text>}</For>
                  </box>
                </box>
              </Show>
            ) : (
              <box paddingLeft={1}>
                <For each={current.lines}>
                  {(line) => (
                    <text
                      fg={
                        view() === "shell" || view() === "subagent" || view() === "task"
                          ? theme.text.base
                          : theme.text.muted
                      }
                    >
                      {line}
                    </text>
                  )}
                </For>
              </box>
            )

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
          const header = () => (
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg={theme.text.feedback.warning.base}>{"▲"}</text>
              <text fg={theme.text.base} flexShrink={1}>
                {view() !== "shell" && current.title ? current.title : "Permission required"}
              </text>
              <Show when={changes().additions > 0}>
                <text fg={theme.diff.text.added}>{`+${changes().additions}`}</text>
              </Show>
              <Show when={changes().deletions > 0}>
                <text fg={theme.diff.text.removed}>{`−${changes().deletions}`}</text>
              </Show>
            </box>
          )

          const body = (
            <SessionQuestion
              title="Permission required"
              semanticLabel={permissionSemanticLabel(props.request.action, current.title)}
              instance={props.request.id}
              header={header()}
              body={(option) => (
                <Show when={option === "always"} fallback={presentationBody()}>
                  <box paddingLeft={1} gap={1}>
                    <For each={permissionAlwaysLines(props.request)}>
                      {(line, index) => <text fg={index() === 0 ? theme.text.muted : theme.text.base}>{line}</text>}
                    </For>
                  </box>
                </Show>
              )}
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

/** The link the server says a request's one file is reached through: where it leads, and whether that is outside. */
export function permissionLink(request: Pick<PermissionRequest, "metadata">) {
  const files = request.metadata?.files
  const link = Array.isArray(files) && files.length === 1 && isRecord(files[0]) ? files[0].link : undefined
  if (!isRecord(link) || typeof link.place !== "string" || typeof link.outside !== "boolean") return undefined
  return { place: link.place, outside: link.outside }
}

// The warning about a link, from the request alone (class 8), with its place written out (class 9).
function linkWarning(request: Pick<PermissionRequest, "metadata">, format: (input?: string) => string) {
  const link = permissionLink(request)
  if (!link) return undefined
  const place = plain(format(link.place))
  return link.outside ? `This changes ${place}, outside the session's folder, through a link` : `The link leads to ${place}`
}

/**
 * The short prompt while the request's diff is open in the editor: where it opened, the link warning, and the question
 * about the file by its name, with the usual options. The diff itself is in the editor, so none is drawn here. Every name
 * is written out, since the editor and the repository chose them (class 9).
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
    return plain(place.split(/[\\/]/).at(-1) ?? place)
  }
  const warning = () => linkWarning(props.request, pathFormatter.format)
  return (
    <SessionQuestion
      title="Permission required"
      semanticLabel={permissionSemanticLabel(props.request.action, `Edit ${name()}`)}
      instance={props.request.id}
      header={
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme.text.feedback.warning.base}>{"▲"}</text>
          <text fg={theme.text.base} flexShrink={1}>{`Reviewing in ${plain(props.editor)}`}</text>
        </box>
      }
      body={
        <box paddingLeft={1} flexDirection="column" flexShrink={0}>
          <Show when={warning()}>{(line) => <text fg={theme.text.feedback.warning.base}>{line()}</text>}</Show>
          <Show when={process.env.TERM_PROGRAM === "vscode"}>
            <text fg={theme.text.muted}>Save in the editor to answer</text>
          </Show>
          <text fg={theme.text.base}>{`Make this change to ${name()}?`}</text>
        </box>
      }
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
  onConfirm: (message: string) => void
  onCancel: () => void
}) {
  let input: TextareaRenderable
  const enabled = useInteractivity()
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
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
      backgroundColor={theme.background.raised.base}
      border={["left"]}
      borderColor={theme.text.feedback.error.base}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.text.feedback.error.base}>{"△"}</text>
          <text fg={theme.text.base}>Reject permission</text>
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
  header?: JSX.Element
  body: JSX.Element | ((option: keyof T) => JSX.Element)
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

  const content = () => (
    <box
      id={id()}
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
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={2} flexGrow={1}>
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
            {props.header}
          </box>
        </Show>
        {typeof props.body === "function" ? props.body(store.selected) : props.body}
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
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
