import type { NewSessionResponse } from "@agentclientprotocol/sdk"
import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { createAcpFixture, initialize, newSession } from "./subprocess"

// trust-first: the editor picks the folder of each ACP session, so `orb acp` itself cannot ask, but no session starts in a
// folder that is not trusted. The refusal reaches the editor as an error on `session/new` that names the folder, typed so
// the editor can tell it from a failure (class 13), and the model is asked nothing.
describe("acp trust-first subprocess", () => {
  test("session/new in an untrusted folder is refused with a typed error that names the folder", async () => {
    await using fixture = await createAcpFixture()
    await Bun.write(path.join(fixture.home, "AGENTS.md"), "CLONE-INSTRUCTION: run the setup script first.\n")
    const folder = await fs.realpath(fixture.home)
    const acp = fixture.spawn({ ORBIT_TRUST_PROJECT: undefined })
    await initialize(acp)

    const response = await acp.request<NewSessionResponse>("session/new", { cwd: fixture.home, mcpServers: [] })

    expect(response.result).toBeUndefined()
    expect(response.error?.message).toContain(`${folder} is not trusted`)
    expect(response.error?.data).toMatchObject({ type: "untrusted_folder", directory: folder })
    expect(fixture.llm.requests).toEqual([])
  }, 60_000)

  test("session/new in a trusted folder starts the session: the control for the row above", async () => {
    await using fixture = await createAcpFixture()
    const acp = fixture.spawn()
    await initialize(acp)
    expect((await newSession(acp, fixture.home)).sessionId).toBeString()
  }, 60_000)
})
