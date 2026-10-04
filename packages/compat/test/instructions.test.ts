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
