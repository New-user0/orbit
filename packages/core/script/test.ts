import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../test/fixture/tmpdir"
import { testArgs } from "../../../tools/test/args"
import { runTests } from "../../../tools/test/watchdog"

await using directory = await tmpdir("oc-")
const home = directory.path
const temporary = path.join(home, "tmp")
await fs.mkdir(temporary)

const environment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      if (process.env.RECORD === "true" && name === "OPENAI_API_KEY") return true
      if (
        /^(?:AWS|AZURE|GOOGLE|GCP|GCLOUD|VERTEX|OPENAI|ANTHROPIC|GEMINI|XAI|CLOUDFLARE|CF_AIG|SNOWFLAKE|AICORE|GITLAB|NPM_CONFIG)_/i.test(
          name,
        )
      ) {
        return false
      }
      return !/(?:^|_)(?:API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i.test(name)
    }),
  ),
  HOME: home,
  ORBIT_TEST_HOME: home,
  // Each test worker process moves into its own folder below this one (test/preload.ts).
  ORBIT_TEST_ROOT: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  ORBIT_CONFIG_DIR: path.join(home, ".config", "orbit"),
  ORBIT_CONFIG: undefined,
  ORBIT_CONFIG_CONTENT: undefined,
  TMPDIR: temporary,
  ...(process.platform === "win32" ? { USERPROFILE: home, TMP: temporary, TEMP: temporary } : {}),
}

// The files in test/serial keep the machine busy, and run alone after the others, so that nothing runs beside them: they are
// left out of the parallel run, and a run that names no file of its own, or one in that folder, runs them once. A run in
// shards runs them in the first. Coverage, reports and timings are the parallel run's.
const extra = process.argv.slice(2)
const serial = "test/serial"
const named = extra.filter((arg) => !arg.startsWith("-") && /\.test\.[cm]?[jt]sx?$|^test\//.test(arg))
const only = named.length > 0 && named.every((arg) => arg.replaceAll("\\", "/").startsWith(serial))
const shard = extra.find((arg) => arg.startsWith("--shard="))
const everyone = named.length === 0 && (shard === undefined || shard.startsWith("--shard=1/"))
const main = only ? 0 : await runTests(testArgs(["--only-failures", `--path-ignore-patterns=${serial}/**`, ...extra]), environment)
const alone =
  only || everyone
    ? await runTests(
        ["test", "--isolate", "--only-failures", ...(only ? named : [serial])],
        environment,
      )
    : 0
process.exitCode = main || alone
