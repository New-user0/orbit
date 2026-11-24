// Runs `bun test` for the package in the current directory: `bun ../../tools/test/run.ts [bun test flags]`.
import { testArgs } from "./args"
import { runTests } from "./watchdog"

process.exitCode = await runTests(testArgs(process.argv.slice(2)))
