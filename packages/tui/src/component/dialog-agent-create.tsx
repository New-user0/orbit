import { TextAttributes } from "@opentui/core"
import { Permission } from "@orbit/schema/permission"
import { plain } from "@orbit/util/plain"
import path from "node:path"
import { createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../context/theme"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import {
  allTools,
  check,
  create as createFile,
  nameProblem,
  toolGroups,
  type AgentDraft,
  type Created,
  type TakenName,
} from "../util/agent-file"

type Step = "scope" | "name" | "prompt" | "description" | "tools" | "model" | "mode" | "confirm"
const steps: readonly Step[] = ["scope", "name", "prompt", "description", "tools", "model", "mode", "confirm"]

/** What the dialog needs from outside, so that it can be drawn and driven without a server. */
export type AgentCreateEnvironment = {
  /** The agents that exist, whatever their scope or mode: a name any of them has is taken. */
  taken: readonly TakenName[]
  /** The `.orbit`-style folder an agent of this scope is written under: its `agents` folder is made inside it. */
  configDirectory: (scope: AgentDraft["scope"]) => string
  /** The folder a project agent must stay inside. */
  projectRoot: string
  /** False while the project's folder is not trusted, which withholds some of what the file says. */
  trusted?: boolean
  /** Tells the server that these files were written, so that it reads them again. */
  notify: (paths: string[]) => Promise<unknown>
  /** Opens a file in the person's editor and returns when it is closed. */
  open: (file: string) => Promise<unknown>
  /** Hands text to the person's editor and returns what they saved. */
  edit: (value: string) => Promise<string | undefined>
  /** Writes the file. The real writer unless a test passes its own. */
  write?: typeof createFile
}

const models: readonly { value: AgentDraft["model"]; title: string; description: string }[] = [
  { value: "inherit", title: "Inherit", description: "Use the model of the agent that calls it" },
  { value: "small", title: "Small", description: "The configured small model: fast and cheap" },
  { value: "large", title: "Large", description: "The configured large model: the most capable" },
]

/**
 * `/agents` > Create agent: a few steps that end in one `agents/<name>.md` file. Escape goes back a step, and out of the
 * first one. Nothing is written until the last step, and an error there blocks the save.
 */
export function DialogAgentCreate(props: AgentCreateEnvironment & { onBack: () => void }) {
  const dialog = useDialog()
  const toast = useToast()
  const [step, setStep] = createSignal<Step>("scope")
  const [draft, setDraft] = createStore<AgentDraft>({
    scope: "project",
    name: "",
    description: "",
    prompt: "",
    tools: undefined,
    model: "inherit",
    permissionMode: undefined,
  })
  const [saving, setSaving] = createSignal(false)
  const move = (by: 1 | -1) => {
    const next = steps[steps.indexOf(step()) + by]
    if (next) return setStep(next)
    if (by === -1) props.onBack()
  }

  const save = async (andOpen: boolean) => {
    if (saving()) return
    const found = check(draft, props.taken)
    if (found.errors.length > 0) return
    setSaving(true)
    const result = await (props.write ?? createFile)({
      configDirectory: props.configDirectory(draft.scope),
      root: draft.scope === "project" ? props.projectRoot : undefined,
      draft: { ...draft, tools: draft.tools?.slice() },
    })
    setSaving(false)
    if (result.type !== "created") return toast.show({ variant: "error", message: refusal(result) })
    await props.notify([result.file]).catch(() => undefined)
    toast.show({ variant: "success", message: `Created the agent ${plain(draft.name)} at ${plain(result.file)}.` })
    dialog.clear()
    if (!andOpen) return
    await props.open(result.file).then(
      () => props.notify([result.file]).catch(() => undefined),
      (error: unknown) =>
        toast.show({
          variant: "warning",
          message: `Could not open ${plain(result.file)}: ${plain(error instanceof Error ? error.message : String(error))}`,
        }),
    )
  }

  return (
    <>
      <Show when={step() === "scope"}>
        <DialogSelect
          title="Create agent: where should it live?"
          current={draft.scope}
          options={[
            { value: "project", title: "Project", description: "Kept with this project, in its .orbit folder" },
            { value: "user", title: "Personal", description: "Kept in your own configuration folder, for every project" },
          ]}
          onSelect={(option) => {
            setDraft("scope", option.value as AgentDraft["scope"])
            move(1)
          }}
          onCancel={() => move(-1)}
        />
      </Show>
      <Show when={step() === "name"}>
        <NameStep value={draft.name} taken={props.taken} onSubmit={(value) => (setDraft("name", value), move(1))} onBack={() => move(-1)} />
      </Show>
      <Show when={step() === "prompt"}>
        <TextStep
          title="Create agent: system prompt"
          hint="Tell the agent who it is and how it works, in the second person."
          value={draft.prompt}
          height={6}
          required="The system prompt is missing."
          edit={props.edit}
          onSubmit={(value) => (setDraft("prompt", value), move(1))}
          onBack={() => move(-1)}
        />
      </Show>
      <Show when={step() === "description"}>
        <TextStep
          title="Create agent: when should it be used?"
          hint="Other agents read this to decide whether to hand work over."
          value={draft.description}
          height={3}
          required="The description is missing."
          edit={props.edit}
          onSubmit={(value) => (setDraft("description", value), move(1))}
          onBack={() => move(-1)}
        />
      </Show>
      <Show when={step() === "tools"}>
        <ToolsStep
          selected={draft.tools}
          onDone={(tools) => (setDraft("tools", tools), move(1))}
          onBack={() => move(-1)}
        />
      </Show>
      <Show when={step() === "model"}>
        <DialogSelect
          title="Create agent: model"
          current={draft.model}
          options={models.map((item) => ({ ...item }))}
          onSelect={(option) => {
            setDraft("model", option.value as AgentDraft["model"])
            move(1)
          }}
          onCancel={() => move(-1)}
        />
      </Show>
      <Show when={step() === "mode"}>
        <DialogSelect
          title="Create agent: permission mode"
          current={draft.permissionMode ?? "unset"}
          options={[
            { value: "unset", title: "Not set", description: "Use the session's permission mode" },
            ...Permission.Mode.literals.map((value) => ({ value, title: value })),
          ]}
          onSelect={(option) => {
            setDraft("permissionMode", option.value === "unset" ? undefined : (option.value as Permission.Mode))
            move(1)
          }}
          onCancel={() => move(-1)}
        />
      </Show>
      <Show when={step() === "confirm"}>
        <ConfirmStep
          draft={draft}
          taken={props.taken}
          trusted={props.trusted}
          saving={saving()}
          directory={props.projectRoot}
          configDirectory={props.configDirectory(draft.scope)}
          onSave={save}
          onBack={() => move(-1)}
        />
      </Show>
    </>
  )
}

function NameStep(props: {
  value: string
  taken: readonly TakenName[]
  onSubmit: (value: string) => void
  onBack: () => void
}) {

  const theme = useTheme().surface("dialog")
  const [error, setError] = createSignal<string>()
  return (
    <DialogPrompt
      title="Create agent: name"
      value={props.value}
      placeholder="code-reviewer"
      description={() => (
        <box>
          <text fg={theme.text.muted}>3 to 50 letters, digits and hyphens. It becomes the file name.</text>
          <Show when={error()}>{(message) => <text fg={theme.text.feedback.error.base}>{message()}</text>}</Show>
        </box>
      )}
      onConfirm={(value) => {
        const name = value.trim()
        const problem =
          nameProblem(name) ??
          (props.taken.some((item) => item.id.toLowerCase() === name.toLowerCase()) ? "An agent with that name exists." : undefined)
        if (problem) return setError(problem)
        props.onSubmit(name)
      }}
      onCancel={props.onBack}
    />
  )
}

function TextStep(props: {
  title: string
  hint: string
  value: string
  height: number
  required: string
  edit: (value: string) => Promise<string | undefined>
  onSubmit: (value: string) => void
  onBack: () => void
}) {
  const theme = useTheme().surface("dialog")
  const [error, setError] = createSignal<string>()
  return (
    <DialogPrompt
      title={props.title}
      size="large"
      height={props.height}
      value={props.value}
      description={() => (
        <box>
          <text fg={theme.text.muted}>{props.hint}</text>
          <Show when={error()}>{(message) => <text fg={theme.text.feedback.error.base}>{message()}</text>}</Show>
        </box>
      )}
      onEditor={props.edit}
      onConfirm={(value) => {
        if (value.trim() === "") return setError(props.required)
        props.onSubmit(value)
      }}
      onCancel={props.onBack}
    />
  )
}

function ToolsStep(props: {
  selected: readonly string[] | undefined
  onDone: (tools: readonly string[] | undefined) => void
  onBack: () => void
}) {
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set(props.selected ?? allTools))
  const [advanced, setAdvanced] = createSignal(false)
  const mark = (on: boolean | "some") => (on === "some" ? "[-]" : on ? "[x]" : "[ ]")
  const state = (tools: readonly string[]) => {
    const count = tools.filter((tool) => chosen().has(tool)).length
    return count === 0 ? false : count === tools.length ? true : ("some" as const)
  }
  const toggle = (tools: readonly string[]) => {
    const everything = tools.every((tool) => chosen().has(tool))
    setChosen(new Set(everything ? [...chosen()].filter((tool) => !tools.includes(tool)) : [...chosen(), ...tools]))
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => [
    { value: "continue", title: "Continue", description: "Use the tools chosen below" },
    { value: "all", title: `${mark(state(allTools))} All tools` },
    ...toolGroups.map((group) => ({ value: `group:${group.id}`, title: `${mark(state(group.tools))} ${group.label}` })),
    { value: "advanced", title: advanced() ? "Hide individual tools" : "Show individual tools" },
    ...(advanced() ? allTools.map((tool) => ({ value: `tool:${tool}`, title: `${mark(chosen().has(tool))} ${tool}` })) : []),
  ])
  return (
    <DialogSelect
      title="Create agent: tools"
      options={options()}
      preserveSelection
      skipFilter
      onSelect={(option) => {
        const value = option.value
        if (value === "continue") return props.onDone(allTools.every((tool) => chosen().has(tool)) ? undefined : allTools.filter((tool) => chosen().has(tool)))
        if (value === "all") return toggle(allTools)
        if (value === "advanced") return setAdvanced(!advanced())
        if (value.startsWith("group:")) return toggle(toolGroups.find((group) => `group:${group.id}` === value)?.tools ?? [])
        toggle([value.slice("tool:".length)])
      }}
      onCancel={props.onBack}
    />
  )
}

function ConfirmStep(props: {
  draft: AgentDraft
  taken: readonly TakenName[]
  trusted?: boolean
  saving: boolean
  directory: string
  configDirectory: string
  onSave: (andOpen: boolean) => void
  onBack: () => void
}) {
  const theme = useTheme().surface("dialog")
  const found = createMemo(() => check(props.draft, props.taken))
  const cut = (value: string) => {
    const flat = plain(value)
    return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat
  }
  const file = () => {
    const full = path.join(props.configDirectory, "agents", `${props.draft.name}.md`)
    return props.draft.scope === "project" ? path.relative(props.directory, full) : full
  }
  const rows = createMemo(() => [
    ["Name", plain(props.draft.name)],
    ["File", plain(file())],
    ["Tools", props.draft.tools === undefined ? "all" : props.draft.tools.length === 0 ? "none" : plain(props.draft.tools.join(", "))],
    ["Model", props.draft.model],
    ["Permission mode", props.draft.permissionMode ?? "not set"],
    ["Description", cut(props.draft.description)],
    ["Prompt", cut(props.draft.prompt)],
  ])
  const options = createMemo<DialogSelectOption<string>[]>(() => [
    ...(found().errors.length === 0
      ? [
          { value: "save", title: "Save" },
          { value: "open", title: "Save and open in your editor" },
        ]
      : []),
    { value: "back", title: "Back" },
  ])
  return (
    <DialogSelect
      title="Create agent: review"
      options={options()}
      skipFilter
      header={
        <box paddingLeft={4} paddingRight={4} paddingBottom={1}>
          <For each={rows()}>
            {([label, value]) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme.text.muted} flexShrink={0}>{`${label}:`}</text>
                <text fg={theme.text.base} wrapMode="word">{value}</text>
              </box>
            )}
          </For>
          <For each={found().errors}>{(message) => <text fg={theme.text.feedback.error.base}>{message}</text>}</For>
          <For each={found().warnings}>{(message) => <text fg={theme.text.feedback.warning.base}>{message}</text>}</For>
          <Show when={props.draft.scope === "project" && props.trusted === false}>
            <text fg={theme.text.feedback.warning.base} attributes={TextAttributes.NONE}>
              This folder is not trusted yet, so the model and permission mode in the file are withheld until it is.
            </text>
          </Show>
        </box>
      }
      onSelect={(option) => {
        if (props.saving) return
        if (option.value === "back") return props.onBack()
        props.onSave(option.value === "open")
      }}
      onCancel={props.onBack}
    />
  )
}

function refusal(result: Exclude<Created, { type: "created" }>) {
  const file = plain(result.file)
  if (result.type === "exists") return `An agent file already exists at ${file}. Nothing was changed.`
  if (result.type === "escapes") return `${file} would be outside the project, because a link leads out of it. Nothing was written.`
  return `Could not create ${file}: ${plain(result.reason)}`
}
