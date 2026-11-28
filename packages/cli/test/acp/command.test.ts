import { describe, expect, test } from "bun:test"
import { runOrb } from "../fixture/orb"

describe("acp command", () => {
  test("is registered", async () => {
    const result = await cli(["--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/^  acp[ \t]+Start an Agent Client Protocol server\r?$/m)
  })
})

function cli(args: string[]) {
  return runOrb(args)
}
