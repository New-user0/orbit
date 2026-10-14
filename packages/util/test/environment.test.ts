import { describe, expect, test } from "bun:test"
import { Environment } from "../src/environment.js"
import { ProgramLookup } from "../src/program-lookup.js"

describe("Environment.assign", () => {
  test("on win32 a name replaces every other spelling of itself", () => {
    expect(Environment.assign({ Path: "a", path: "b", Other: "c" }, { PATH: "d" }, "win32")).toEqual({
      Other: "c",
      PATH: "d",
    })
  })

  test("elsewhere names are compared exactly", () => {
    expect(Environment.assign({ Path: "a" }, { PATH: "d" }, "linux")).toEqual({ Path: "a", PATH: "d" })
  })

  test("an own value replaces a value of the same spelling in place", () => {
    expect(Object.keys(Environment.assign({ A: "1", B: "2" }, { A: "3" }, "win32"))).toEqual(["A", "B"])
  })
})

describe("ProgramLookup.environment", () => {
  test("on win32 the lookup variable replaces any other spelling in the environment it is given", () => {
    if (process.platform !== "win32") return
    const env = ProgramLookup.environment({ nodefaultcurrentdirectoryinexepath: "", KEEP: "1" })
    expect(env).toEqual({ KEEP: "1", NoDefaultCurrentDirectoryInExePath: "1" })
  })
})
