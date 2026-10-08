import { expect, test } from "bun:test"
import path from "node:path"
import { classify } from "../src/framework/argv"
import { PrintBooleanFlags, RootValueFlags, Subcommands } from "../src/commands/commands"

// The words of the message are exactly the tokens that follow the flags: the parser sees each boolean flag in its inline
// form, so a word such as yes or run can never be taken for a value or a subcommand.
const printed = (argv: string[]) => {
  const line = classify(argv)
  expect(line.mode).toBe("print")
  return line.args
}

test.each([
  [["-p", "run", "the", "tests"], ["--print=true", "run", "the", "tests"]],
  [["-p", "debug", "x"], ["--print=true", "debug", "x"]],
  [["-p", "yes", "do", "it"], ["--print=true", "yes", "do", "it"]],
  [["-pc", "yes"], ["--print=true", "--continue=true", "yes"]],
  [["--model", "x/y", "-p", "fix", "it"], ["--model", "x/y", "--print=true", "fix", "it"]],
  [["fix it", "-p"], ["fix it", "--print=true"]],
  [["--print", "service", "stop"], ["--print=true", "service", "stop"]],
  [["--standalone", "-p", "yes"], ["--standalone=true", "--print=true", "yes"]],
  [["-pm", "x/y", "run", "it"], ["--print=true", "-m", "x/y", "run", "it"]],
  [["-p", "--", "--foo", "bar"], ["--print=true", "--", "--foo", "bar"]],
  [["-p", "x", "--", "-p", "run"], ["--print=true", "x", "--", "-p", "run"]],
  [["--title", "-p", "-p", "x"], ["--title", "-p", "--print=true", "x"]],
  [["-p"], ["--print=true"]],
  [["-p", "--thinking", "yes"], ["--print=true", "--thinking=true", "yes"]],
  [["-p", "--bare=false", "x"], ["--print=true", "--bare=false", "x"]],
])("%j is a print line", (argv, expected) => {
  expect(printed(argv)).toEqual(expected)
})

test.each([
  [["run", "-p"]],
  [["run", "-p", "say ok"]],
  [["eval", "s", "--resume", "x"]],
  [["mcp", "add", "x", "--", "server", "-p"]],
  [["--standalone", "run", "-p", "yes"]],
  [["--server", "-p", "run", "a"]],
  [["--", "-p"]],
  [["service", "start"]],
  [["dir"]],
  [[]],
])("%j is left to the root command unchanged", (argv) => {
  expect(classify(argv)).toEqual({ mode: "root", args: argv })
})

test("a subcommand name is any command the root dispatches on", () => {
  for (const name of Subcommands) expect(classify([name, "-p"]).mode).toBe("root")
  expect(Subcommands).toContain("run")
  expect(Subcommands).toContain("debug")
})

test("the flag tables match the flags that orb --help prints", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", "--help"], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [, help] = await Promise.all([child.exited, new Response(child.stdout).text()])
  const flags = help.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^ {2}--([\w-]+)(?:, -(\w))?(?: (string|integer|float|choice|<[^>]+>))?(?: {2,}|$)/)
    return match ? [{ long: match[1], short: match[2], value: match[3] !== undefined }] : []
  })

  const values = flags.filter((flag) => flag.value)
  expect(values.map((flag) => flag.long).sort()).toEqual([...RootValueFlags.long].sort())
  expect(values.flatMap((flag) => (flag.short ? [flag.short] : [])).sort()).toEqual([...RootValueFlags.short].sort())
  // Every boolean flag the help prints, apart from the ones every command has, is one that -p rewrites.
  const builtin = ["help", "version", "wizard"]
  const booleans = flags.filter((flag) => !flag.value && !builtin.includes(flag.long))
  for (const flag of booleans) {
    expect(Object.keys(PrintBooleanFlags)).toContain(flag.long)
    expect(PrintBooleanFlags[flag.long]).toBe(flag.short)
  }
})
