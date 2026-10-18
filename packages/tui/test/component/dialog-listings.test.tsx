import { expect, test } from "bun:test"
import { DialogAgent } from "../../src/component/dialog-agent"
import { DialogSkill } from "../../src/component/dialog-skill"
import { agent, renderLocal } from "../fixture/local"
import { directory, json } from "../fixture/tui-client"

// Repository-supplied names and descriptions reach the pickers through `plain`: no control byte survives to the frame.
const hostile = "line\u001b]0;pwned\u0007 one\r\ntwo three"

test("the agent picker draws a hostile name and description without control characters", async () => {
  await using setup = await renderLocal({
    agents: [
      { ...agent("build"), description: hostile },
      { ...agent("ev\u001b[2Jil"), mode: "subagent", description: "ok" },
    ],
  })
  setup.dialog.replace(() => <DialogAgent />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Select agent"))
  expect(frame).toContain("one")
  expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})

test("the skill picker draws a hostile name and description without control characters", async () => {
  await using setup = await renderLocal({
    fetch: async (url) => {
      if (url.pathname !== "/api/skill") return
      return json({
        location: { directory },
        data: [{ id: "one", name: "sk\u001b[2Jill", description: hostile, path: "/x", content: "" }],
      })
    },
  })
  setup.dialog.replace(() => <DialogSkill onSelect={() => {}} />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Skills"))
  expect(frame).toContain("one")
  expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})
