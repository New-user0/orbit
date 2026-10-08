import type { Plugin } from "@orbit/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { AssistantFooter } from "../../../routes/session/assistant-footer"
import { footerOutcome, turnDuration } from "../../../routes/session/rows"
import { errorMessage } from "../../../util/error"
import { StoryFooter } from "./footer"
import type { Story } from "./index"
import { ASSISTANT_FOOTER_FIXTURES } from "./assistant-footer.fixtures"

function AssistantFooterStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [index, setIndex] = createSignal(0)
  const [narrow, setNarrow] = createSignal(false)
  const fixture = createMemo(() => ASSISTANT_FOOTER_FIXTURES[index()]!)
  const position = createMemo(() => fixture().messages.findIndex((message) => message.id === fixture().target))
  const message = createMemo(() => {
    const found = fixture().messages[position()]
    return found?.type === "assistant" ? found : undefined
  })

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      {
        bind: "ctrl+g",
        title: "Next fixture",
        group: "Storybook",
        run: () => setIndex((value) => (value + 1) % ASSISTANT_FOOTER_FIXTURES.length),
      },
      { bind: "ctrl+w", title: "Toggle narrow width", group: "Storybook", run: () => setNarrow((value) => !value) },
      {
        bind: "ctrl+x",
        title: "Reset",
        group: "Storybook",
        run: () => {
          setIndex(0)
          setNarrow(false)
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.raised.base}>
      <box paddingTop={1} flexGrow={1} flexDirection="column">
        {/* The outcome comes from the production helper over the fixture conversation; nothing is sent anywhere. */}
        {message() && (
          <AssistantFooter
            agent={message()!.agent}
            color={theme.text.base}
            model="Fixture model"
            duration={turnDuration(message()!, fixture().messages, position(), false)}
            tokensPerSecond={42.5}
            error={message()!.error ? errorMessage(message()!.error) : undefined}
            retry={message()!.retry}
            interrupted={false}
            outcome={footerOutcome(fixture().messages, position())}
            width={narrow() ? 27 : dimensions().width}
          />
        )}
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / assistant footer"
        details={[`fixture: ${fixture().label}`, narrow() ? "narrow" : "wide"]}
        controls={[
          { shortcut: "ctrl+g", label: "next fixture" },
          { shortcut: "ctrl+w", label: "narrow / wide" },
          { shortcut: "ctrl+x", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const assistantFooterStory: Story = {
  id: "assistant-footer",
  title: "Assistant footer",
  render: (context) => <AssistantFooterStory context={context} />,
}
