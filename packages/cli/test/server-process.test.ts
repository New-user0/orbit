import { expect, test } from "bun:test"
import { ServerProcess } from "../src/server-process"

test("a private or foreground server trusts folders only when its environment asks it to", () => {
  for (const mode of ["default", "stdio"] as const) {
    expect(ServerProcess.trustOptions(mode, {})).toEqual({ implicit: false })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "true" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "TRUE" })).toEqual({ implicit: true })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "0" })).toEqual({ implicit: false })
    expect(ServerProcess.trustOptions(mode, { ORBIT_TRUST_PROJECT: "" })).toEqual({ implicit: false })
  }
})

test("the background service never takes its trust from the environment, which belongs to its first client", () => {
  expect(ServerProcess.trustOptions("service", {})).toEqual({ implicit: false })
  expect(ServerProcess.trustOptions("service", { ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: false })
  expect(ServerProcess.trustOptions("service", { ORBIT_TRUST_PROJECT: "true" })).toEqual({ implicit: false })
})
