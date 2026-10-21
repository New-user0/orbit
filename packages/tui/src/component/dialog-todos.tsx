import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import { Keymap } from "../context/keymap"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { bodyText } from "../util/renderer"
import { latestTodos, type TodoItem } from "../util/tool-display"
import { SPINNER_FRAMES } from "./spinner-frames"

/** /todos: the session's plan in full, read the way the plan dock reads it. */
export function DialogTodos(props: { readonly sessionID?: string }) {
  const data = useData()
  const items = createMemo(() => (props.sessionID ? latestTodos(data.session.message.list(props.sessionID) ?? []) : []))
  return <TodosView items={items()} session={props.sessionID !== undefined} />
}

/** The dialog's layout, apart from the data store so that a story can draw it from a fixture. */
export function TodosView(props: { readonly items: readonly TodoItem[]; readonly session: boolean }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  // The list scrolls inside the dialog, so a plan longer than the screen is not cut off at its edge.
  const height = () => Math.max(3, Math.min(props.items.length, Math.floor(dimensions().height * 0.6) - 4))
  let scroll: ScrollBoxRenderable | undefined
  Keymap.createLayer(() => ({
    mode: "modal",
    commands: [
      { bind: "up", title: "Scroll plan up", group: "Plan", run: () => scroll?.scrollBy(-1) },
      { bind: "down", title: "Scroll plan down", group: "Plan", run: () => scroll?.scrollBy(1) },
      { bind: "pageup", title: "Previous plan page", group: "Plan", run: () => scroll?.scrollBy(-height()) },
      { bind: "pagedown", title: "Next plan page", group: "Plan", run: () => scroll?.scrollBy(height()) },
      { bind: "home", title: "First step", group: "Plan", run: () => scroll?.scrollTo(0) },
      { bind: "end", title: "Last step", group: "Plan", run: () => scroll?.scrollTo(Infinity) },
    ],
  }))
  const count = (status: TodoItem["status"]) => props.items.filter((item) => item.status === status).length
  const header = () =>
    [
      `${props.items.length} ${props.items.length === 1 ? "step" : "steps"}`,
      `${count("completed")} done`,
      ...(count("in_progress") > 0 ? [`${count("in_progress")} in progress`] : []),
      `${count("pending")} open`,
    ].join(" · ")
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text.base} attributes={1}>
        Plan
      </text>
      <Show
        when={props.items.length > 0}
        fallback={
          <text fg={theme.text.muted}>{props.session ? "This session has no plan yet." : "No session is open."}</text>
        }
      >
        <text fg={theme.text.muted}>{header()}</text>
        <scrollbox
          ref={(value: ScrollBoxRenderable) => (scroll = value)}
          height={height()}
          scrollbarOptions={{ visible: false }}
        >
          <For each={props.items}>
            {(item) => (
              <box flexDirection="row" gap={1}>
                <text
                  flexShrink={0}
                  fg={
                    item.status === "completed"
                      ? theme.text.feedback.success.base
                      : item.status === "in_progress"
                        ? theme.brand.base
                        : theme.text.muted
                  }
                >
                  {item.status === "completed" ? "●" : item.status === "in_progress" ? SPINNER_FRAMES[0] : "○"}
                </text>
                {/* The model wrote the text, so control characters are written out here. */}
                <text fg={item.status === "in_progress" ? theme.text.base : theme.text.muted}>
                  {bodyText(item.content)}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
        <Show when={props.items.length > height()}>
          <text fg={theme.text.muted}>↑/↓ scroll · {props.items.length} steps</text>
        </Show>
      </Show>
    </box>
  )
}
