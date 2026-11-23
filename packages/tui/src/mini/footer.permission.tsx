// Permission UI body for the direct-mode footer.
//
// Renders inside the footer when the reducer pushes a FooterView of type
// "permission". Uses a three-stage state machine (permission.shared.ts):
//
//   permission → shows the request with Allow once / Always / Reject buttons
//   always     → confirmation step before granting permanent access
//   reject     → text field for the rejection message
//
// Keyboard: left/right to select, enter to confirm, esc to reject.
// The diff view (when available) uses the same diff component as scrollback
// tool snapshots.
/** @jsxImportSource @opentui/solid */
import { TextAttributes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal } from "solid-js"
import {
  createPermissionBodyState,
  permissionAlwaysLines,
  permissionCancel,
  permissionEscape,
  permissionHover,
  permissionInfo,
  permissionLabel,
  permissionOptions,
  permissionReject,
  permissionRun,
  permissionShift,
  permissionWarnings,
  type PermissionOption,
} from "./permission.shared"
import { stringWidth } from "../util/string-width"
import { toolFiletype } from "./tool"
import { transparent, type RunBlockTheme, type RunFooterTheme } from "./theme"
import type { MiniPermissionRequest, PermissionReply } from "./types"
import { Hanging } from "../component/hanging"
import { PatchDiff } from "../component/patch-diff"

function buttons(
  list: PermissionOption[],
  selected: PermissionOption,
  theme: RunFooterTheme,
  disabled: boolean,
  onHover: (option: PermissionOption) => void,
  onSelect: (option: PermissionOption) => void,
  mono: boolean,
) {
  return (
    <box width="100%" flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={0}>
      <For each={list}>
        {(option) => (
          <box
            width={stringWidth(permissionLabel(option)) + 2}
            height={1}
            flexShrink={0}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={option === selected ? theme.actionFocusedBg : transparent}
            onMouseMove={() => {
              if (!disabled) onHover(option)
            }}
            onMouseUp={() => {
              if (!disabled) onSelect(option)
            }}
          >
            <text
              wrapMode="none"
              fg={option === selected ? theme.actionFocusedText : theme.actionSecondaryText}
              attributes={option === selected && mono ? TextAttributes.INVERSE : undefined}
            >
              {permissionLabel(option)}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

/** @internal Exported to test managed textarea submission without permission navigation. */
export function RejectField(props: {
  theme: RunFooterTheme
  text: string
  disabled: boolean
  onChange: (text: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  let area: TextareaRenderable | undefined

  createEffect(() => {
    if (!area || area.isDestroyed) {
      return
    }

    if (area.plainText !== props.text) {
      area.setText(props.text)
      area.cursorOffset = props.text.length
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed || props.disabled) {
        return
      }
      area.focus()
    })
  })

  return (
    <textarea
      width="100%"
      minHeight={1}
      maxHeight={3}
      wrapMode="word"
      placeholder="Tell Orbit what to do differently"
      placeholderColor={props.theme.muted}
      textColor={props.theme.formfieldText}
      focusedTextColor={props.theme.formfieldFocusedText}
      backgroundColor={props.theme.surface}
      focusedBackgroundColor={props.theme.formfieldFocusedBg}
      cursorColor={props.theme.formfieldFocusedText}
      focused={!props.disabled}
      onSubmit={props.onConfirm}
      onContentChange={() => {
        if (!area || area.isDestroyed) {
          return
        }
        props.onChange(area.plainText)
      }}
      onKeyDown={(event) => {
        if (event.name === "escape") {
          event.preventDefault()
          props.onCancel()
          return
        }
      }}
      ref={(item) => {
        area = item
      }}
    />
  )
}

export function RunPermissionBody(props: {
  request: MiniPermissionRequest
  directory?: () => string
  theme: RunFooterTheme
  block: RunBlockTheme
  onReply: (input: PermissionReply) => void | Promise<void>
  mono?: boolean
}) {
  const dims = useTerminalDimensions()
  const [size, setSize] = createSignal(dims())
  const width = () => size().width
  const compact = () => width() < 56 || size().height < 12
  const [state, setState] = createSignal(createPermissionBodyState(props.request))
  const stage = createMemo(() => state().stage)
  const info = createMemo(() => permissionInfo(props.request, props.directory?.(), props.mono))
  const links = createMemo(() => permissionWarnings(props.request, props.directory?.()))
  // A patch that edits several files gets one diff per file, each under its own path.
  const diffs = createMemo(() => info().diffs ?? (info().diff ? [{ file: info().file ?? "", diff: info().diff! }] : []))
  let scroll: ScrollBoxRenderable | undefined
  const scrollbar = createMemo(() => ({
    visible: !props.mono,
    trackOptions: {
      backgroundColor: props.theme.surface,
      foregroundColor: props.theme.line,
    },
  }))
  const opts = createMemo(() =>
    permissionOptions(stage()).filter((option) => option !== "always" || (props.request.save?.length ?? 0) > 0),
  )
  const busy = createMemo(() => state().submitting)
  const controlsWidth = () => opts().reduce((total, option) => total + stringWidth(permissionLabel(option)) + 3, -1)
  const hint = () =>
    compact() && width() < 56
      ? "pgup/pgdn scroll"
      : `${props.mono ? "left/right" : "⇆"} select  enter confirm  esc ${stage() === "always" ? "cancel" : "reject"}`
  const inlineControls = () => controlsWidth() + stringWidth(hint()) + 1 <= width() - (compact() ? 0 : 5)
  // The sentence where it fits, and otherwise the short form, which keeps the word outside or inside.
  const summary = () => {
    const full = links().summary
    if (full === undefined || stringWidth(full) <= width() - (compact() ? 0 : 5)) return full
    return links().short
  }
  // Each linked end on a line of its own, under what is approved (class 8).
  const warnings = () => (
    <Show when={links().lines.length > 0}>
      <box width="100%" flexDirection="column" flexShrink={0} paddingLeft={compact() ? 0 : 1}>
        <For each={links().lines}>{(line) => <Hanging text={line} fg={props.theme.warning} />}</For>
      </box>
    </Show>
  )
  const title = createMemo(() => {
    if (stage() === "always") {
      return "Always allow"
    }

    if (stage() === "reject") {
      return width() < 24 ? "Reject" : "Reject permission"
    }

    return width() < 24 ? "Permission" : "Permission required"
  })

  createEffect(() => {
    const id = props.request.id
    if (state().requestID === id) {
      return
    }

    setState(createPermissionBodyState(props.request))
  })

  const shift = (dir: -1 | 1) => {
    setState((prev) => permissionShift(prev, dir, opts()))
  }

  createEffect(() => {
    stage()
    props.request.id
    if (scroll && !scroll.isDestroyed) scroll.scrollTo(0)
  })

  const submit = async (next: PermissionReply) => {
    setState((prev) => ({
      ...prev,
      submitting: true,
    }))

    try {
      await props.onReply(next)
    } catch {
      setState((prev) => ({
        ...prev,
        submitting: false,
      }))
    }
  }

  const run = (option: PermissionOption) => {
    const cur = state()
    const next = permissionRun(cur, props.request.id, option)
    if (next.state !== cur) {
      setState(next.state)
    }

    if (!next.reply) {
      return
    }

    void submit(next.reply)
  }

  const reject = () => {
    const next = permissionReject(state(), props.request.id)
    if (!next) {
      return
    }

    void submit(next)
  }

  const cancelReject = () => {
    setState((prev) => permissionCancel(prev))
  }

  useKeyboard((event) => {
    const cur = state()
    if (cur.stage === "reject") {
      return
    }

    if (event.name === "pageup" || event.name === "pagedown") {
      scroll?.scrollBy(event.name === "pageup" ? -1 : 1, "viewport")
      event.preventDefault()
      return
    }

    if (cur.submitting) {
      if (["left", "right", "h", "l", "tab", "return", "escape"].includes(event.name)) {
        event.preventDefault()
      }
      return
    }

    if (event.name === "tab") {
      shift(event.shift ? -1 : 1)
      event.preventDefault()
      return
    }

    if (event.name === "left" || event.name === "h") {
      shift(-1)
      event.preventDefault()
      return
    }

    if (event.name === "right" || event.name === "l") {
      shift(1)
      event.preventDefault()
      return
    }

    if (event.name === "return") {
      run(state().selected)
      event.preventDefault()
      return
    }

    if (event.name !== "escape") {
      return
    }

    setState((prev) => permissionEscape(prev))
    event.preventDefault()
  })

  return (
    <box
      width="100%"
      height="100%"
      minHeight={0}
      flexDirection="column"
      backgroundColor={props.theme.surface}
      onSizeChange={function () {
        setSize({ width: this.width, height: this.height })
      }}
    >
      <box
        paddingLeft={compact() ? 0 : 2}
        paddingRight={compact() ? 0 : 3}
        paddingTop={compact() ? 0 : 1}
        paddingBottom={compact() ? 0 : 1}
        gap={compact() ? 0 : 1}
        flexShrink={0}
      >
        <box flexDirection="column">
          <text height={1} fg={props.theme.text} wrapMode="none" truncate>
            <span style={{ fg: props.theme.permission }}>{props.mono ? "! " : "△ "}</span>
            {title()}
          </text>
          {/* One line in every stage, above what scrolls. */}
          <Show when={summary()}>
            {(line) => (
              <text height={1} fg={props.theme.warning} wrapMode="none" truncate>
                {line()}
              </text>
            )}
          </Show>
        </box>
        <Show when={!compact() && stage() === "reject"}>
          <text fg={props.theme.muted}>Tell Orbit what to do differently</text>
        </Show>
      </box>

      <Show
        when={stage() !== "reject"}
        fallback={
          <box width="100%" flexGrow={1} minHeight={0} justifyContent="flex-end">
            <box
              backgroundColor={props.theme.line}
              flexDirection={width() >= 80 ? "row" : "column"}
              alignItems={width() >= 80 ? "center" : "stretch"}
              justifyContent="space-between"
              paddingLeft={compact() ? 0 : 2}
              paddingRight={compact() ? 0 : 3}
              paddingTop={compact() ? 0 : 1}
              paddingBottom={compact() ? 0 : 1}
              gap={compact() ? 0 : 1}
              flexShrink={0}
            >
              <box width={width() >= 80 ? undefined : "100%"} flexGrow={1} flexShrink={1} minWidth={0}>
                <RejectField
                  theme={props.theme}
                  text={state().message}
                  disabled={busy()}
                  onChange={(text) => {
                    setState((prev) => ({
                      ...prev,
                      message: text,
                    }))
                  }}
                  onConfirm={reject}
                  onCancel={cancelReject}
                />
              </box>
              <Show
                when={!busy()}
                fallback={
                  <text fg={props.theme.running} height={1} wrapMode="none" truncate flexShrink={0}>
                    {compact() ? "Waiting…" : "Waiting for permission event…"}
                  </text>
                }
              >
                <box flexDirection="row" flexWrap="wrap" columnGap={compact() ? 1 : 2} flexShrink={0}>
                  <text fg={props.theme.text} height={1} wrapMode="none" flexShrink={0}>
                    enter <span style={{ fg: props.theme.muted }}>{compact() ? "reject" : "confirm"}</span>
                  </text>
                  <text fg={props.theme.text} height={1} wrapMode="none" flexShrink={0}>
                    esc <span style={{ fg: props.theme.muted }}>{compact() ? "back" : "cancel"}</span>
                  </text>
                </box>
              </Show>
            </box>
          </box>
        }
      >
        <box
          width="100%"
          flexGrow={1}
          minHeight={0}
          paddingLeft={compact() ? 0 : 1}
          paddingRight={compact() ? 0 : 3}
          paddingBottom={compact() ? 0 : 1}
        >
          <scrollbox
            width="100%"
            flexGrow={1}
            minHeight={0}
            viewportOptions={{
              paddingLeft: compact() ? 0 : 1,
              paddingRight: props.mono ? 0 : 1,
            }}
            verticalScrollbarOptions={scrollbar()}
            ref={(item) => {
              scroll = item
            }}
          >
            <Switch>
              <Match when={stage() === "permission"}>
                <box width="100%" flexDirection="column" flexShrink={0} gap={compact() ? 0 : 1}>
                  <box width="100%" paddingLeft={compact() ? 0 : 1} flexShrink={0}>
                    <Hanging
                      lead={`${info().icon} `}
                      leadFg={props.theme.muted}
                      text={info().title}
                      fg={props.theme.text}
                    />
                  </box>
                  {warnings()}
                  <Show
                    when={diffs().length > 0}
                    fallback={
                      <Show
                        when={info().patch}
                        fallback={
                          <box width="100%" flexDirection="column" flexShrink={0} gap={compact() ? 0 : 1}>
                            <For each={info().lines}>
                              {(line) => (
                                // Text of several rows, a diff in mono, is right of where a warning starts.
                                <box width="100%" flexShrink={0} paddingLeft={line.includes("\n") ? 2 : 0}>
                                  <Hanging text={line} fg={props.theme.text} />
                                </box>
                              )}
                            </For>
                          </box>
                        }
                      >
                        {(patch) => (
                          <box width="100%" flexShrink={0} paddingLeft={2}>
                            <Show
                              when={props.block.syntax}
                              fallback={
                                <text width="100%" fg={props.theme.muted} wrapMode="word" flexShrink={0}>
                                  {patch()}
                                </text>
                              }
                            >
                              {(syntax) => (
                                <code
                                  width="100%"
                                  flexShrink={0}
                                  wrapMode="word"
                                  filetype="diff"
                                  drawUnstyledText={false}
                                  streaming={true}
                                  syntaxStyle={syntax()}
                                  content={patch()}
                                  fg={props.theme.muted}
                                />
                              )}
                            </Show>
                          </box>
                        )}
                      </Show>
                    }
                  >
                    <For each={diffs()}>
                      {(item) => (
                        <box width="100%" flexDirection="column" flexShrink={0} gap={compact() ? 0 : 1}>
                          <Show when={diffs().length > 1}>
                            <Hanging text={`Path: ${item.file}`} fg={props.theme.muted} />
                          </Show>
                          <Show
                            when={width() >= 40}
                            fallback={
                              <box width="100%" flexShrink={0} paddingLeft={2}>
                                <text width="100%" fg={props.theme.text} wrapMode="word" flexShrink={0}>
                                  {item.diff}
                                </text>
                              </box>
                            }
                          >
                            <PatchDiff
                              diff={item.diff}
                              hunkFg={props.block.diffLineNumber}
                              view="unified"
                              filetype={toolFiletype(item.file)}
                              syntaxStyle={props.block.syntax}
                              showLineNumbers={true}
                              width="100%"
                              flexShrink={0}
                              wrapMode="word"
                              fg={props.theme.text}
                              addedBg={props.block.diffAddedBg}
                              removedBg={props.block.diffRemovedBg}
                              contextBg={props.block.diffContextBg}
                              addedSignColor={props.block.diffHighlightAdded}
                              removedSignColor={props.block.diffHighlightRemoved}
                              lineNumberFg={props.block.diffLineNumber}
                              lineNumberBg={props.block.diffContextBg}
                              addedLineNumberBg={props.block.diffAddedLineNumberBg}
                              removedLineNumberBg={props.block.diffRemovedLineNumberBg}
                            />
                          </Show>
                        </box>
                      )}
                    </For>
                  </Show>
                  <Show when={diffs().length === 0 && !info().patch && info().lines.length === 0}>
                    <text width="100%" fg={props.theme.muted} flexShrink={0}>
                      No diff provided
                    </text>
                  </Show>
                </box>
              </Match>
              <Match when={true}>
                <box width="100%" flexDirection="column" flexShrink={0} gap={compact() ? 0 : 1}>
                  <For each={permissionAlwaysLines(props.request)}>
                    {(line) => (
                      <box width="100%" flexShrink={0}>
                        <Hanging text={line} fg={props.theme.text} />
                      </box>
                    )}
                  </For>
                  {warnings()}
                </box>
              </Match>
            </Switch>
          </scrollbox>
        </box>

        <box
          width="100%"
          flexDirection={inlineControls() ? "row" : "column"}
          justifyContent="space-between"
          gap={compact() ? 0 : 1}
          paddingLeft={compact() ? 0 : 2}
          paddingRight={compact() ? 0 : 3}
          paddingTop={compact() ? 0 : 1}
          paddingBottom={compact() ? 0 : 1}
          flexShrink={0}
          backgroundColor={props.theme.pane}
        >
          <box width={inlineControls() ? controlsWidth() : "100%"} flexShrink={0}>
            {buttons(
              opts(),
              state().selected,
              props.theme,
              busy(),
              (option) => {
                setState((prev) => permissionHover(prev, option))
              },
              run,
              props.mono ?? false,
            )}
          </box>
          <Show
            when={!busy()}
            fallback={
              <text fg={props.theme.running} height={1} wrapMode="none" truncate flexShrink={0}>
                {compact() ? "Waiting…" : "Waiting for permission event…"}
              </text>
            }
          >
            <text fg={props.theme.text} height={1} wrapMode="none" flexShrink={0}>
              <Show
                when={compact() && width() < 56}
                fallback={
                  <>
                    {props.mono ? "left/right" : "⇆"}
                    <span style={{ fg: props.theme.muted }}>{" select  "}</span>
                    enter<span style={{ fg: props.theme.muted }}>{" confirm  "}</span>
                    esc<span style={{ fg: props.theme.muted }}> {stage() === "always" ? "cancel" : "reject"}</span>
                  </>
                }
              >
                pgup/pgdn<span style={{ fg: props.theme.muted }}> scroll</span>
              </Show>
            </text>
          </Show>
        </box>
      </Show>
    </box>
  )
}
