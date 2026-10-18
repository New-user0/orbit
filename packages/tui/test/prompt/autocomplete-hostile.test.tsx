import { expect, test } from "bun:test"
import { createAppFixture, promptReady } from "../fixture/app"
import { directory, json } from "../fixture/tui-client"

// Skill and command text comes from repository files, so the @ and / pickers draw it through `plain`.
const hostile = "line\u001b]0;pwned\u0007 one‮\r\ntwo three"
const location = { directory, project: { id: "proj_test", directory, canonical: directory } }

async function draw(prefix: string, trusted: string) {
  await using setup = await createAppFixture({
    fetch: async (url) => {
      if (url.pathname === "/api/skill")
        return json({
          location,
          data: [
            { id: "zzskill\u001b[2J", name: "x", description: hostile, path: "/x", content: "" },
            { id: "zzgood", name: "x", description: "fine", path: "/y", content: "" },
          ],
        })
      if (url.pathname === "/api/command")
        return json({
          location,
          data: [
            { name: "zzcmd\u001b[2J", description: hostile },
            { name: "zzgood", description: "fine" },
          ],
        })
      if (url.pathname === "/api/fs/find") return json({ location, data: [] })
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  await setup.mockInput.typeText(prefix + "zz")
  return await setup.waitForFrame((frame) => frame.includes(trusted))
}

test.each([
  ["@", "@zzgood"],
  ["/", "/zzgood"],
])("the %s picker draws hostile skill and command text without control characters", async (prefix, trusted) => {
  const frame = await draw(prefix, trusted)
  expect(frame).toContain("fine")
  expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})
