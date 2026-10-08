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
  [["-p", "--no-thinking", "yes", "do", "it"], ["--print=true", "--thinking=false", "yes", "do", "it"]],
  [["-p", "--thinking", "false", "yes"], ["--print=true", "--thinking=true", "false", "yes"]],
  [["-p", "--bare", "true", "or", "false:"], ["--print=true", "--bare=true", "true", "or", "false:"]],
  [["-p", "-c", "false", "story"], ["--print=true", "--continue=true", "false", "story"]],
  [["--print", "no", "x"], ["--print=true", "no", "x"]],
  [["-p", "--constructor", "x"], ["--print=true", "--constructor", "x"]],
  [["-s=abc", "-p", "run"], ["-s=abc", "--print=true", "run"]],
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
  [["-s=abc", "run", "-p"]],
  [["--standalone", "true", "run", "-p"]],
  [["--standalone", "yes", "serve", "-p"]],
  [["-c", "false", "run", "-p"]],
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

async function helpFlags(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [, help] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return help.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^ {2}--([\w-]+)(?:, -(\w))?(?: (string|integer|float|choice|<[^>]+>))?(?: {2,}|$)/)
    return match ? [{ long: match[1], short: match[2], value: match[3] !== undefined }] : []
  })
}

// `orb -p --help` lists what a print line is parsed with, and `orb --help` is what a person reads first, so both are checked.
test("the flag tables match the flags that orb --help and orb -p --help print", async () => {
  const root = await helpFlags(["--help"])
  const print = await helpFlags(["-p", "--help"])

  const values = [...root, ...print].filter((flag) => flag.value)
  expect([...new Set(values.map((flag) => flag.long))].sort()).toEqual([...RootValueFlags.long].sort())
  expect([...new Set(values.flatMap((flag) => (flag.short ? [flag.short] : [])))].sort()).toEqual(
    [...RootValueFlags.short].sort(),
  )
  // Apart from the ones every command has, the booleans a print line prints are exactly the ones -p rewrites, and the
  // root help lists only ones of those.
  const builtin = ["help", "version", "wizard"]
  const booleans = (flags: typeof root) => flags.filter((flag) => !flag.value && !builtin.includes(flag.long))
  // yolo and dangerously-skip-permissions are aliases of auto that the help does not print.
  const hidden = ["yolo", "dangerously-skip-permissions"]
  expect(booleans(print).map((flag) => flag.long).sort()).toEqual(
    Object.keys(PrintBooleanFlags)
      .filter((name) => !hidden.includes(name))
      .sort(),
  )
  for (const flag of [...booleans(print), ...booleans(root)]) {
    expect(Object.keys(PrintBooleanFlags)).toContain(flag.long)
    expect(PrintBooleanFlags[flag.long]).toBe(flag.short)
  }
}, 60_000)
