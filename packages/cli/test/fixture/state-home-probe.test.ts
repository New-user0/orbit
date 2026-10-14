import { test } from "bun:test"

// Run only by state-home.test.ts in a child process: reports the folder the preload chose.
test("probe", () => {
  if (process.env.ORBIT_STATE_HOME_PROBE) console.log(`STATE_HOME=${process.env.XDG_STATE_HOME}`)
})
