import { afterEach, beforeEach, expect, test } from "bun:test"
import { ProgramLookup } from "./program-lookup.js"

const name = "NoDefaultCurrentDirectoryInExePath"
const windows = process.platform === "win32"
const onWindows = windows ? test : test.skip
const elsewhere = windows ? test.skip : test
let before: string | undefined

beforeEach(() => {
  before = process.env[name]
  delete process.env[name]
})

afterEach(() => {
  if (before === undefined) delete process.env[name]
  else process.env[name] = before
  delete process.env.ORBIT_PROGRAM_LOOKUP_TEST
})

onWindows("install sets the variable", () => {
  ProgramLookup.install()

  expect(process.env[name]).toBe("1")
})

onWindows("install can run again, and after the variable was removed", () => {
  ProgramLookup.install()
  ProgramLookup.install()
  delete process.env[name]
  ProgramLookup.install()

  expect(process.env[name]).toBe("1")
})

elsewhere("install leaves the environment alone", () => {
  ProgramLookup.install()

  expect(process.env[name]).toBeUndefined()
})

onWindows("environment adds the variable to what a child is handed", () => {
  expect(ProgramLookup.environment({ KEEP: "1" })).toEqual({ KEEP: "1", [name]: "1" })
})

onWindows("environment starts from the variables of the process when the child is handed none", () => {
  process.env.ORBIT_PROGRAM_LOOKUP_TEST = "1"

  const environment = ProgramLookup.environment(undefined)

  expect(environment?.ORBIT_PROGRAM_LOOKUP_TEST).toBe("1")
  expect(environment?.[name]).toBe("1")
})

elsewhere("environment hands back what it was given", () => {
  const given = { KEEP: "1" }

  expect(ProgramLookup.environment(given)).toBe(given)
  expect(ProgramLookup.environment(undefined)).toBeUndefined()
})
