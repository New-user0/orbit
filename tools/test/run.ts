// Runs `bun test` for the package in the current directory: `bun ../../tools/test/run.ts [bun test flags]`.
import { testArgs } from "./args"

const child = Bun.spawn({
  cmd: [process.execPath, ...testArgs(process.argv.slice(2))],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
const interrupt = () => child.kill("SIGINT")
const terminate = () => child.kill("SIGTERM")
process.once("SIGINT", interrupt)
process.once("SIGTERM", terminate)
process.exitCode = await child.exited
process.off("SIGINT", interrupt)
process.off("SIGTERM", terminate)
