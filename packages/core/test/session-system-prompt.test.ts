import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@orbit/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["Edit", "Read", "Bash"])
  expect(prompt).not.toContain("${ORBIT_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use Edit for targeted changes to existing text files")
  expect(prompt).toContain("`old_string`")
  expect(prompt).toContain("Use Read to look at files before you change them")
})

test("names the tools the way the model is offered them, and not by their old names", () => {
  const prompt = SessionSystemPrompt.make(["Bash", "TaskOutput", "Write", "Agent", "TodoWrite", "EnterPlanMode"])
  for (const old of ["shell_output", "the edit tool", "the subagent tool", "oldString", "replaceAll", "enter_plan_mode"])
    expect(prompt).not.toContain(old)
  expect(prompt).toContain("TaskOutput")
  expect(prompt).toContain("`run_in_background`")
  // Guidance for a tool the model was not given is left out.
  expect(SessionSystemPrompt.make(["Read"])).not.toContain("Use Edit")
  // The guidance is looked up by the current name, so a list of old names asks for none of it.
  expect(SessionSystemPrompt.make(["edit", "read"])).not.toContain("Use Edit")
})
