import { describe, expect, test } from "bun:test"
import { CompatInstructions } from "../src/instructions.js"
import { CompatNames } from "../src/names.js"

const foreign = Object.values(CompatNames.foreign).flat()

describe("CompatInstructions.filenames", () => {
  test("lists the native files first and the reference vendor's file last, only while enabled", () => {
    expect(CompatInstructions.filenames(true)).toEqual(["ORBIT.md", "AGENTS.md", CompatNames.vendor.instructions])
    expect(CompatInstructions.filenames(false)).toEqual(["ORBIT.md", "AGENTS.md"])
  })

  test("never lists another product's rule file as an instruction file", () => {
    for (const enabled of [true, false])
      for (const file of foreign) expect(CompatInstructions.filenames(enabled)).not.toContain(file)
  })
})

describe("CompatInstructions.localFilenames", () => {
  test("lists the native local file first and the reference vendor's local file last, only while enabled", () => {
    expect(CompatInstructions.localFilenames(true)).toEqual(["ORBIT.local.md", CompatNames.vendor.localInstructions])
    expect(CompatInstructions.localFilenames(false)).toEqual(["ORBIT.local.md"])
  })

  test("shares no name with the shared files, so that the two slots never collide", () => {
    for (const name of CompatInstructions.localFilenames(true)) expect(CompatInstructions.filenames(true)).not.toContain(name)
  })
})

describe("CompatInstructions.rules", () => {
  test("lists the rule and instruction files other products keep only while enabled", () => {
    expect(CompatInstructions.rules(true)).toEqual(foreign)
    expect(foreign.length).toBeGreaterThan(0)
    expect(CompatInstructions.rules(false)).toEqual([])
  })

  test("follows the switch in the list /init reads", () => {
    const inspected = (enabled: boolean) => [
      ...CompatInstructions.filenames(enabled),
      ...CompatInstructions.rules(enabled),
    ]

    expect(inspected(true)).toEqual(["ORBIT.md", "AGENTS.md", CompatNames.vendor.instructions, ...foreign])
    expect(inspected(false)).toEqual(["ORBIT.md", "AGENTS.md"])
  })
})
