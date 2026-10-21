import { createMemo, createSignal, For, Show } from "solid-js"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { bodyText } from "../../util/renderer"
import { SPINNER_FRAMES } from "../../component/spinner-frames"
import { latestTodos } from "../../util/tool-display"

/**
 * The session's plan, docked above the prompt: its latest todo call's input or task tool's task list. It opens while work remains and
 * folds to one line once every step is done; clicking the header toggles it.
 */
export function PlanDock(props: { sessionID: string }) {
  const theme = useTheme()
  const data = useData()
  const [toggled, setToggled] = createSignal<boolean>()
  const items = createMemo(() => latestTodos(data.session.message.list(props.sessionID) ?? []))
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
