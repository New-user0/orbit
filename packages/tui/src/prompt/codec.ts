import type { Prompt, PromptInput } from "@orbit/schema"
import type { PromptCommand } from "@orbit/schema/prompt"
import { Skill } from "@orbit/schema/skill"
import type { Types } from "effect"

export type EditablePromptInput = Types.DeepMutable<PromptInput.Prompt>

type ProjectedPrompt = Pick<Prompt, "text" | "files" | "agents"> & {
  readonly skills?: ReadonlyArray<{ readonly id: string; readonly mention?: PromptInput.SkillAttachment["mention"] }>
  readonly command?: PromptCommand
}

/** How a prompt is drawn: a slash command's prompt as the command the person typed, `/name arguments`. */
export function shownPrompt(input: { readonly text: string; readonly command?: PromptCommand }) {
  return input.command ? `/${input.command.name} ${input.command.arguments}`.trimEnd() : input.text
}

/**
 * A stored or queued prompt as input to edit and send again. A slash command's prompt is given back as the command the
 * person typed, `/name arguments` (`/name ` with none), so sending it runs the command again, as the reference puts it
 * back; its text is the command's expansion, which only the model reads.
 */
export function projectedPromptInput(input: ProjectedPrompt): EditablePromptInput {
  return {
    text: input.command ? `/${input.command.name} ${input.command.arguments}` : input.text,
    files: input.files?.map((file) => ({
      uri: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
      name: file.name,
      description: file.description,
      mention: file.mention ? { ...file.mention } : undefined,
    })),
    agents: input.agents?.map((agent) => ({
      name: agent.name,
      mention: agent.mention ? { ...agent.mention } : undefined,
    })),
    skills: input.skills?.map((skill) => ({
      id: Skill.ID.make(skill.id),
      mention: skill.mention ? { ...skill.mention } : undefined,
    })),
  }
}
