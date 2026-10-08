import type { SessionMessageInfo } from "@orbit/client"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { bodyText } from "../../util/renderer"
import { SPINNER_FRAMES } from "../../component/spinner-frames"
import { canonicalToolName, todoItems, toolDisplayMetadata } from "../../util/tool-display"

/** The plan in the latest assistant message that carries one, whichever name its tool call was recorded with. */
export function planItems(messages: ReadonlyArray<SessionMessageInfo>) {
  for (const message of messages.toReversed()) {
    if (message.type !== "assistant") continue
    // A todo call carries the plan in its input; the task tools report the whole task list in their metadata.
    const call = message.content.findLast(
      (part) =>
        part.type === "tool" &&
        (canonicalToolName(part.name) === "todo" ||
          (canonicalToolName(part.name).startsWith("task_") && toolDisplayMetadata(part.state).todos)),
    )
    if (call?.type !== "tool") continue
    if (canonicalToolName(call.name) !== "todo") return todoItems(toolDisplayMetadata(call.state).todos)
    if (typeof call.state.input !== "string") return todoItems(call.state.input.todos)
  }
  return []
}

/**
 * The session's plan, docked above the prompt: its latest todo call's input or task tool's task list. It opens while work remains and
 * folds to one line once every step is done; clicking the header toggles it.
 */
export function PlanDock(props: { sessionID: string }) {
  const theme = useTheme()
  const data = useData()
  const [toggled, setToggled] = createSignal<boolean>()
  const items = createMemo(() => planItems(data.session.message.list(props.sessionID) ?? []))
  const done = createMemo(() => items().filter((item) => item.status === "completed").length)
  const open = () => toggled() ?? done() < items().length

  return (
    <Show when={items().length > 0}>
      <box flexShrink={0} paddingLeft={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} onMouseUp={() => setToggled(!open())}>
          <text fg={theme.brand.base}>◎</text>
          <text fg={theme.text.muted}>plan</text>
          <text fg={theme.text.base}>{`${done()}/${items().length}`}</text>
          <text fg={theme.text.muted}>{open() ? "▾" : "▸"}</text>
        </box>
        <Show when={open()}>
          <For each={items()}>
            {(item) => (
              <box flexDirection="row" gap={1} paddingLeft={2}>
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
                <text fg={item.status === "in_progress" ? theme.text.base : theme.text.muted} wrapMode="none">
                  {bodyText(item.content)}
                </text>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}
