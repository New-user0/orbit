import { expect, test } from "bun:test"
import { Env } from "../src/env"

test("session environment omits the run's config overlay", () => {
  process.env.ORBIT_CONFIG_CONTENT = '{"mcp":{}}'
  process.env.ORBIT_CONFIG_CONTENT_FILE = "/overlay.json"
  process.env.ORBIT_CONFIG_DIR_KEPT = "included"

  const environment = Env.session()

  delete process.env.ORBIT_CONFIG_CONTENT
  delete process.env.ORBIT_CONFIG_CONTENT_FILE
  delete process.env.ORBIT_CONFIG_DIR_KEPT

  expect(environment.ORBIT_CONFIG_CONTENT).toBeUndefined()
  expect(environment.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
  expect(environment.ORBIT_CONFIG_DIR_KEPT).toBe("included")
})

test("session environment omits server credentials", () => {
  const previousPassword = process.env.ORBIT_PASSWORD
  const previousLegacyPassword = process.env.ORBIT_SERVER_PASSWORD
  const previousValue = process.env.ORBIT_SESSION_ENV_TEST
  process.env.ORBIT_PASSWORD = "password"
  process.env.ORBIT_SERVER_PASSWORD = "legacy"
  process.env.ORBIT_SESSION_ENV_TEST = "included"

  const environment = Env.session()

  if (previousPassword === undefined) delete process.env.ORBIT_PASSWORD
  else process.env.ORBIT_PASSWORD = previousPassword
  if (previousLegacyPassword === undefined) delete process.env.ORBIT_SERVER_PASSWORD
  else process.env.ORBIT_SERVER_PASSWORD = previousLegacyPassword
  if (previousValue === undefined) delete process.env.ORBIT_SESSION_ENV_TEST
  else process.env.ORBIT_SESSION_ENV_TEST = previousValue

  expect(environment.ORBIT_PASSWORD).toBeUndefined()
  expect(environment.ORBIT_SERVER_PASSWORD).toBeUndefined()
  expect(environment.ORBIT_SESSION_ENV_TEST).toBe("included")
})
