import type { Plugin } from "@orbit/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { batch, createSignal, onMount } from "solid-js"
import { DialogAgentCreate } from "../../../component/dialog-agent-create"
import { DialogAgentEdit, type EditableAgent } from "../../../component/dialog-agent-edit"
import type { Created } from "../../../util/agent-file"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

const project = "/Users/kit/code/orbit-app"

// The agents that exist, as the dialog checks a new name against: Orbit's own, a personal one, and a project's.
const TAKEN: ReadonlyArray<{ label: string; names: { id: string; scope?: string }[] }> = [
  { label: "built-in agents only", names: [{ id: "build" }, { id: "plan" }] },
  {
    label: "with a personal and a project agent",
    names: [{ id: "build" }, { id: "plan" }, { id: "reviewer", scope: "user" }, { id: "release-notes", scope: "project" }],
  },
]

// The agents the edit list is offered: files of the person's and the project's, among definitions that are not files to edit.
const EDITABLE: EditableAgent[] = [
  { id: "reviewer", source: { scope: "user", path: "/Users/kit/.config/orbit/agents/reviewer.md" } },
  { id: "release-notes", source: { scope: "project", path: `${project}/.orbit/agents/release-notes.md` } },
  { id: "org-policy", source: { scope: "managed", path: "/etc/orbit/agents/org-policy.md" } },
  { id: "from-plugin", source: { scope: "project", path: `${project}/plugins/x/agents/from-plugin.md`, plugin: "x" } },
  { id: "build" },
]

// What writing the file comes to, for the last step to show.
const OUTCOMES = ["created", "exists", "escapes", "failed"] as const

function AgentCreateStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [taken, setTaken] = createSignal(0)
  const [trusted, setTrusted] = createSignal(true)
  const [outcome, setOutcome] = createSignal(0)
  const [message, setMessage] = createSignal("dialog open")

  // The real dialog, with the file, the server and the editor kept here: nothing is written, so it is safe to explore.
  const open = () => {
    props.context.ui.dialog.show(
      () => (
        <DialogAgentCreate
          taken={TAKEN[taken()].names}
          configDirectory={(scope) => (scope === "project" ? `${project}/.orbit` : "/Users/kit/.config/orbit")}
          projectRoot={project}
          trusted={trusted()}
          notify={async (paths) => void setMessage(`the server was told about ${paths.join(", ")}`)}
          open={async (file) => void setMessage(`the editor would open ${file}`)}
          edit={async (value) => `${value}\n(edited in the editor)`}
          write={async (input): Promise<Created> => {
            const file = `${input.configDirectory}/agents/${input.draft.name}.md`
            const result = OUTCOMES[outcome()]
            setMessage(`write ${result}: ${file}`)
            return result === "created"
              ? { type: "created", file }
              : result === "failed"
                ? { type: "failed", file, reason: "the disk is full" }
                : { type: result, file }
          }}
          onBack={() => props.context.ui.dialog.clear()}
        />
      ),
      () => setMessage((current) => (current === "dialog open" ? "dialog dismissed" : current)),
    )
    setMessage("dialog open")
  }
  onMount(open)

  props.context.keymap.layer(() => ({
    commands: [
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
      { bind: "f2", title: "Cycle the agents that exist", group: "Storybook", run: () => (setTaken((value) => (value + 1) % TAKEN.length), open()) },
      { bind: "f3", title: "Toggle: folder trusted", group: "Storybook", run: () => (setTrusted((value) => !value), open()) },
      { bind: "f4", title: "Cycle what writing the file comes to", group: "Storybook", run: () => (setOutcome((value) => (value + 1) % OUTCOMES.length), open()) },
      {
        bind: "f5",
        title: "Open the edit list",
        group: "Storybook",
        run: () => {
          props.context.ui.dialog.show(() => (
            <DialogAgentEdit
              agents={EDITABLE}
              open={async (file) => void setMessage(`the editor would open ${file}`)}
              notify={async (paths) => void setMessage(`the server was told about ${paths.join(", ")}`)}
              onBack={() => props.context.ui.dialog.clear()}
            />
          ))
          setMessage("edit list open")
        },
      },
      {
        bind: "f6",
        title: "Reset the fixture",
        group: "Storybook",
        run: () => {
          batch(() => {
            setTaken(0)
            setTrusted(true)
            setOutcome(0)
          })
          open()
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.base}>
      <box paddingLeft={2} paddingRight={2} paddingTop={1} flexGrow={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          /agents: Create agent
        </text>
        <text fg={theme.text.muted}>The dialog opens over this screen. Any change below opens it again from the start.</text>
        <text fg={theme.text.muted}>Nothing is written, sent or opened.</text>
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / create agent"
        details={[TAKEN[taken()].label, trusted() ? "trusted folder" : "untrusted folder", `write: ${OUTCOMES[outcome()]}`]}
        message={message()}
        controls={[
          { shortcut: "f2", label: "agents that exist" },
          { shortcut: "f3", label: "trust" },
          { shortcut: "f4", label: "write outcome" },
          { shortcut: "f5", label: "edit list" },
          { shortcut: "f6", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const agentCreateStory: Story = {
  id: "agent-create",
  title: "Create agent dialog",
  render: (context) => <AgentCreateStory context={context} />,
}
