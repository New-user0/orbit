import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Duration, Effect, Layer, PlatformError, Sink, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { PowerShellInspect } from "../../src/shell/powershell-inspect"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { which } from "../../src/util/which"
import { currentDirectoryOnPath, plant } from "../fixture/decoy"
import { tmpdir } from "../fixture/tmpdir"

// Structure of PowerShell text comes from PowerShell's own parser. These rows run the real parser (Windows PowerShell 5.1
// here, pwsh elsewhere) and pin every hiding spelling that the hand-written tokenizer lost in the reviews of #74, then
// the fail-closed rows run an injected host so they need no PowerShell at all.

const real = Layer.provide(PowerShellParse.layerWith(), LayerNode.compile(CrossSpawnSpawner.node))
const hasHost = Boolean(which("pwsh") ?? (process.platform === "win32" ? which("powershell") : null))
const noHost = "skipped: no pwsh or powershell on PATH"

function parse(text: string, layer: Layer.Layer<PowerShellParse.Service> = real) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const parser = yield* PowerShellParse.Service
      return yield* parser.parse(text)
    }).pipe(Effect.provide(layer)),
  )
}

// Results of the real parser, computed once and concurrently because a cold Windows PowerShell takes most of a second.
const rows = new Map<string, PowerShellParse.Result>()

function realResult(text: string) {
  const result = rows.get(text)
  if (!result) throw new Error(`row was not prepared: ${JSON.stringify(text)}`)
  return result
}

function summary(text: string) {
  const result = realResult(text)
  if (!result.valid) throw new Error(`invalid (${result.reason}): ${JSON.stringify(text)}`)
  return result.summary
}

const commandNames = (text: string) => summary(text).commands.map((command) => command.name)
const redirects = (text: string) => summary(text).statements.flatMap((statement) => statement.redirects)

// Every command or write that PowerShell runs after a spelling that the hand-written tokenizer swallowed.
const hiddenCommand: Array<[string, string]> = [
  ["a glued comment after a variable", "$x<# c #>; Remove-Item a"],
  ["a glued comment after an assignment", "$x = $y<# c #>; Remove-Item a"],
  ["a glued comment after a member", "$x.Length<# c #>; Remove-Item a"],
  ["a glued comment after ${name}", "${x}<# c #>; Remove-Item a"],
  ["a glued comment after an index", "$x[0]<# c #>; Remove-Item a"],
  ["a glued comment after a subexpression", "$(1)<# c #>; Remove-Item a"],
  ["a glued comment after an array expression", "@(1)<# c #>; Remove-Item a"],
  ["a glued comment after a number", "1<# c #>; Remove-Item a"],
  ["a glued comment after a type", "[int]<# c #>; Remove-Item a"],
  ["a glued comment that spans lines", "$x<# c\n#>; Remove-Item a"],
  ["a line comment after an expression", "$x # note\nRemove-Item a"],
  ["a line comment after a command", "Write-Output a # c\nRemove-Item b"],
  ["a backtick before CR LF", "Write-Output a;`\r\nRemove-Item b"],
  ["a paren in an argument", "Write-Output (Remove-Item a)"],
  ["a subexpression in an argument", "Write-Output $(Remove-Item a)"],
  ["a paren after a comma", "Write-Output a, (Remove-Item b)"],
  ["a paren after -name:", "Write-Output -name:(Remove-Item b)"],
  ["a subexpression after -name:", "Write-Output -name:$(Remove-Item b)"],
  ["a paren in an index", "Write-Output $x[(Remove-Item a)]"],
  ["a paren after ]", "Write-Output ([int](Remove-Item a))"],
  ["a subexpression in a double-quoted string", 'Write-Output "a $(Remove-Item b) c"'],
  ["an if body", "if ($true) { Remove-Item a } else { Get-Item b }"],
  ["a try body", "try { Remove-Item a } catch { Write-Output $_ }"],
  ["a foreach body", "foreach ($i in 1..3) { Remove-Item $i }"],
  ["a script block argument", "Get-ChildItem | ForEach-Object { Remove-Item $_ }"],
  ["a function body", "function f { Remove-Item a }"],
  ["a trap body", "trap { Remove-Item a }"],
  ["a param default", "param($a = (Remove-Item x))\nGet-Date"],
  // `m is not an escape in either edition (PowerShell 6 and later read `e as ESC), so this spelling is portable.
  ["a backtick in a command name", "Remove-Ite`m x"],
]

// A member call that the tokenizer did not see as one: the summary has to say that the statement reaches a member.
const hiddenMember: Array<[string, string]> = [
  ["a member after a blank line", "$w.\n\nWrite('payload')"],
  ["a member after a comment", "$w. # c\nWrite('payload')"],
  ["a member after a comment line", "$w.\n# c\nWrite('payload')"],
  ["a member after a glued comment", "$w.<# c #>Write('payload')"],
  ["a member after a backtick", "$w.`\nWrite('payload')"],
  ["a static member after blank lines", "[IO.File]::\n\nDelete('x')"],
  ["a static member after a comment", "[IO.File]:: # c\nDelete('x')"],
  ["a member of a parenthesised expression", "(Get-Item a).\n\nDelete()"],
  ["a plain instance call", "$x.Foo(1)"],
  ["a plain static call", "[Environment]::SetEnvironmentVariable('a','b')"],
]

// A write that PowerShell makes: [text, operator, target].
const hiddenWrite: Array<[string, string, string, string]> = [
  ["a quoted string", "'x' > f.txt", ">", "f.txt"],
  ["a range", "1..3 > f.txt", ">", "f.txt"],
  ["a parenthesised expression", "( 'x' ) > f.txt", ">", "f.txt"],
  ["a return", "return 'x' > f.txt", ">", "f.txt"],
  ["a comma expression", ",'x' > f.txt", ">", "f.txt"],
  ["a glued comment", "$x<#c#>>f.txt", ">", "f.txt"],
  ["a glued ${env:} target", "$v>${env:R74}\\escape-env.txt", ">", "${env:R74}\\escape-env.txt"],
  ["a glued ${HOME} target", "$(Get-Date)>${HOME}\\.ssh\\authorized_keys", ">", "${HOME}\\.ssh\\authorized_keys"],
  ["an expression redirect on a command", "Write-Output ($x) > f.txt", ">", "f.txt"],
  ["an append", "Write-Output a >> f.txt", ">>", "f.txt"],
  ["an error stream", "Write-Output a 2> f.txt", "2>", "f.txt"],
  ["all streams", "Write-Output a *> f.txt", "*>", "f.txt"],
  ["a pipeline end", "Get-Content a.txt | Select-Object -First 1 > out.txt", ">", "out.txt"],
]

// Spellings from the earlier reviews of #74 that the parser has to resolve: the command or write is in the summary.
const moreHiddenCommand: Array<[string, string]> = [
  ["a comma element with a comment", "Write-Output a,<# c #>(Remove-Item b)"],
  ["a comment after -name:", "Write-Output -name:<# c #>(Remove-Item b)"],
  ["a comment after a leading ]", "Write-Output ([int]<# c #>(Remove-Item a))"],
  ["a #' comment after a member", "$x.Length#'\nRemove-Item a"],
  ["a #' comment after a command argument", "Write-Output a #'\nRemove-Item b"],
  ["a #' comment after a subexpression", "$(1)#'\nRemove-Item a"],
  ["a bracket argument before ;", "Write-Output [a; Remove-Item b; ]"],
  ["a glued comment after a member before |", "$x.y<# c #>| Remove-Item"],
  ["a backtick before ; in a parameter name", "Write-Output -a`;b; Remove-Item c"],
  ["a form feed before the break", "Write-Output a\f\nRemove-Item b"],
  // Review 2: an argument-mode accessor before a line break does not swallow the next line.
  ['an argument-mode member after a string and a line break', 'Write-Output "s".\nRemove-Item a'],
  ["an argument-mode member after a paren and a line break", "Write-Output (gi x).\nRemove-Item a"],
  ["an argument-mode member after a number and a line break", "Write-Output (1).\nRemove-Item a"],
  // Review 5: a backtick glued to the end of an argument, before CR LF, in each position.
  ["a glued backtick and CR LF after an argument", "Write-Output a`\r\nRemove-Item b"],
  ["a glued backtick and CR LF after -a:b", "Write-Output -a:b`\r\nRemove-Item c"],
  ["a glued backtick and CR LF after a command name", "Write-Output`\r\nRemove-Item b"],
  ["a glued backtick and CR LF inside an if body", "if ($true) { Write-Output a`\r\nRemove-Item b }"],
  // A redirect target that ends in a dot, in :: or in an unclosed bracket does not run on into the next line.
  ["a target ending in . before a line break", "$x > out.\nRemove-Item a"],
  ["a target ending in :: before a line break", "$x > out::\nRemove-Item a"],
  ["a target holding [ and a later ]", "$x > f[; Remove-Item a; ]"],
  ["a glued comment after an expression in argument position", "Write-Output $x.Length<# c #>; Remove-Item a"],
  ["a target ending in #;", "$x > f#; Remove-Item a"],
  ["a target ending in <#", "$x > f<#; Remove-Item a"],
]
const moreHiddenMember: Array<[string, string]> = [
  ["a member in an argument after a backtick", "Write-Output $x.`\nLength"],
  ["a form feed before the break", "$w.\f\nWrite('payload')"],
]
const moreHiddenWrite: Array<[string, string, string, string]> = [
  ["a > glued to its target", "Write-Output a >f.txt", ">", "f.txt"],
  ["a >> glued to its target", "Write-Output a >>f.txt", ">>", "f.txt"],
  ["a 2> glued to its target", "Write-Output a 2>f.txt", "2>", "f.txt"],
  ["a target ending in a dot", "'x' > f.", ">", "f."],
  ["a target holding [", "'x' > f[1].txt", ">", "f[1].txt"],
  ["a target ending in #;", "$x > f#;", ">", "f#"],
  ["a target ending in <#", "$x > f<#", ">", "f<#"],
  ["a target holding a glued comment", "'x' > f<#c#>", ">", "f<#c#>"],
  ["a target holding =", "'x' > f=1", ">", "f=1"],
  ["a target that looks like a parameter, after a command", "Write-Output a > -a:<# c #>", ">", "-a:"],
  ["a target that looks like a parameter, after an assignment", "$y = $x > -a:<# c #>", ">", "-a:"],
  ["a write glued after -a:$x.y", "Write-Output -a:$x.y>f", ">", "f"],
  ['a write glued after -a:"s"', 'Write-Output -a:"s">f', ">", "f"],
  ["a write glued after -a:@(1)", "Write-Output -a:@(1)>f", ">", "f"],
  ["a write glued after a,$x.Length", "Write-Output a,$x.Length>f", ">", "f"],
  ["a write glued after a,'a'", "Write-Output a,'a'>f", ">", "f"],
  ["a write glued after ]", "Write-Output ]>f", ">", "f"],
  ["a write glued after -a ]", "Write-Output -a ]>f", ">", "f"],
]

const everything = [
  ...moreHiddenCommand.map((row) => row[1]),
  ...moreHiddenMember.map((row) => row[1]),
  ...moreHiddenWrite.map((row) => row[1]),
  "Microsoft.PowerShell.Foo\\Get-ChildItem",
  "Microsoft.PowerShell.Utility\\Get-ChildItem",
  "Get-Date",
  "Write-Output a>f.txt",
  "Write-Output a, `\r\nRemove-Item b",
  "'x' > $null",
  "'x' > ${null}",
  "'x' > $global:null",
  "[IO.File]::Delete('x')",
  ...hiddenCommand.map((row) => row[1]),
  ...hiddenMember.map((row) => row[1]),
  ...hiddenWrite.map((row) => row[1]),
  "Remove-Item `\r\n victim",
  "Remove-Item -Rec`urse x",
  "Remove-Item -Recurse -Force x",
  "Get-ChildItem",
  "Get-Date # comment",
  "Get-ChildItem | Select-Object -First 1",
  "(Get-Item a) | Get-Date",
  "1 | Get-Date",
  "Remove-Item 'a b' $x",
  "& 'Remove-Item' a",
  "Remove-Item a",
  "Write-Output (1)",
  "Write-Output $(1)",
  'Write-Output "a $x"',
  "Get-ChildItem | ForEach-Object { $_ }",
  "param($a = (Remove-Item x))\nGet-Date",
  "Write-Output a 2>&1",
  "Write-Output a > $null",
  "$x = Get-Date",
  "Write-Output @args",
  "Write-Output $env:PATH",
  "Write-Output a -x:$y -z:1 -w:'q'",
  "echo --% x",
  "echo \u2013-% x",
  "echo \u2014\u2014% x",
  "echo \u2015\u2015% x",
  "echo \u2014% x",
  "using namespace System.IO\nGet-Date",
  "#Requires -Version 3\nGet-Date",
  "[IO.StreamWriter]'f'",
  "'f' -as [IO.StreamWriter]",
  "${alias:Get-Content} = 'Remove-Item'",
  "Microsoft.PowerShell.Utility\\Set-Alias Get-Content Remove-Item",
  "Microsoft.PowerShell.Management\\Get-ChildItem",
  "Foo\\Get-ChildItem",
  "git.exe status",
  "C:\\tools\\git.exe status",
  "ls .",
  "iex 'Remove-Item a'",
  "& $x a",
  ". ./a.ps1",
  "G\u0435t-Date",
  "Write-Output 'a' ; ; Get-Date",
  "begin { Get-ChildItem } process { Get-ChildItem } end { Get-ChildItem }",
  "",
  "Write-Output \"unterminated",
  "$x.\nRemove-Item victim",
  "Get-Date && Remove-Item a",
  "'git' status",
  "$x`\r\nRemove-Item b",
  "Hyper-V\\Remove-VM x",
  "posh-git\\Remove-Item x",
  "a\\b\\Remove-Item x",
  "Foo\\rm x",
  "Microsoft.PowerShell.Management\\ls",
  ".\\Remove-Item x",
  "..\\a\\Remove-Item x",
  "\\\\host\\share\\Remove-Item x",
  "C:\\a\\Remove-Item x",
  nested(150),
]

// Nested script blocks: the script walks the statements of each block, so the work grows with the depth.
function nested(depth: number) {
  return "& {".repeat(depth) + " Get-Date " + "}".repeat(depth)
}

beforeAll(async () => {
  if (!hasHost) return
  const queue = [...new Set(everything)]
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let text = queue.shift(); text !== undefined; text = queue.shift()) rows.set(text, await parse(text))
    }),
  )
}, 180_000)

describe.skipIf(!hasHost)(`PowerShellParse real parser${hasHost ? "" : ` (${noHost})`}`, () => {
  test.each(hiddenCommand)("shows the command behind %s", (_label, text) => {
    expect(commandNames(text)).toContain("remove-item")
  })

  test("a command in a nested position is marked nested and one at the top is not", () => {
    expect(summary("Remove-Item a").commands[0].nested).toBe(false)
    expect(summary("Write-Output (Remove-Item a)").commands.map((command) => command.nested)).toEqual([false, true])
    expect(summary("function f { Remove-Item a }").commands[0].nested).toBe(true)
    expect(summary("Get-ChildItem | ForEach-Object { Remove-Item $_ }").commands.map((command) => command.nested)).toEqual(
      [false, false, true],
    )
  })

  test.each(hiddenMember)("flags member access for %s", (_label, text) => {
    const statements = summary(text).statements
    expect(statements.some((statement) => statement.memberAccess)).toBe(true)
    // The line that follows the accessor is part of the member call, so it must not also be a command of its own.
    expect(summary(text).commands.filter((command) => !command.nested)).toEqual([])
  })

  test.each(hiddenWrite)("reports the write behind %s", (_label, text, operator, target) => {
    expect(redirects(text)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file", operator, target })]))
  })

  test.each(moreHiddenCommand)("shows the command behind %s", (_label, text) => {
    expect(commandNames(text)).toContain("remove-item")
  })

  test.each(moreHiddenMember)("flags member access for %s", (_label, text) => {
    expect(summary(text).statements.some((statement) => statement.memberAccess)).toBe(true)
  })

  test.each(moreHiddenWrite)("reports the write behind %s", (_label, text, operator, target) => {
    expect(redirects(text)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "file", operator, target })]))
  })

  test("a module-qualified name is an application through the real parser, whatever the module", () => {
    for (const text of ["Microsoft.PowerShell.Foo\\Get-ChildItem", "Microsoft.PowerShell.Utility\\Get-ChildItem"]) {
      expect(summary(text).commands[0]).toMatchObject({ name: "get-childitem", class: "application" })
    }
    expect(summary("Get-ChildItem").commands[0]).toMatchObject({ class: "cmdlet" })
  })

  test("control: a > inside a bareword is part of the argument, as PowerShell reads it", () => {
    expect(redirects("Write-Output a>f.txt")).toEqual([])
    expect(summary("Write-Output a>f.txt").commands[0].arguments.map((argument) => argument.text)).toEqual(["a>f.txt"])
  })

  // Why the qualified name must be an application: Windows PowerShell 5.1 runs the working folder's script of that path.
  test.skipIf(process.platform !== "win32" || !which("powershell"))(
    "control: Windows PowerShell runs a planted script for a module-qualified name",
    async () => {
      await using dir = await tmpdir()
      await fs.mkdir(path.join(dir.path, "Microsoft.PowerShell.Foo"))
      await fs.writeFile(path.join(dir.path, "Microsoft.PowerShell.Foo", "Get-ChildItem.ps1"), "'planted-script-ran'")
      const run = Bun.spawn(
        [which("powershell")!, "-NoProfile", "-NonInteractive", "-Command", "Microsoft.PowerShell.Foo\\Get-ChildItem"],
        { cwd: dir.path, stdout: "pipe", stderr: "ignore" },
      )
      expect(await new Response(run.stdout).text()).toContain("planted-script-ran")
    },
    30_000,
  )

  test("only a $null target is marked as a null sink", () => {
    const sink = (text: string) => redirects(text)[0].nullSink
    expect(sink("'x' > $null")).toBe(true)
    expect(sink("'x' > ${null}")).toBe(true)
    expect(sink("'x' > $global:null")).toBeUndefined()
    expect(sink("Write-Output a > $null")).toBe(true)
    expect(redirects("'x' > f.txt")[0].nullSink).toBeUndefined()
  })

  test("a call on a type is a placeholder in the statement's elements and not in commands", () => {
    const result = summary("[IO.File]::Delete('x')")
    expect(result.commands).toEqual([])
    expect(result.statements[0].elements[0].command).toMatchObject({ placeholder: true })
  })

  test("a backtick before CR LF in argument position makes the next line an argument, not a command", () => {
    const result = summary("Write-Output a, `\r\nRemove-Item b")
    expect(result.commands.map((command) => command.name)).toEqual(["write-output"])
    expect(result.commands[0].arguments).toHaveLength(2)
  })

  test("the call and dot-source operators are kept through the real parser", () => {
    expect(summary("& 'Remove-Item' a").commands[0].operator).toBe("&")
    expect(summary(". ./a.ps1").commands[0].operator).toBe(".")
    expect(summary("Get-Date").commands[0].operator).toBeUndefined()
  })

  test("a backtick before CR LF continues the command and the argument is plain", () => {
    const [command] = summary("Remove-Item `\r\n victim").commands
    expect(command.name).toBe("remove-item")
    expect(command.arguments.map((argument) => argument.value)).toEqual(["victim"])
  })

  test("a backtick in a parameter name is resolved", () => {
    const [command] = summary("Remove-Item -Rec`urse x").commands
    expect(command.arguments[0]).toMatchObject({ kind: "CommandParameterAst", parameter: "Recurse" })
    expect(command.arguments[1].value).toBe("x")
  })

  test("a -name:value argument carries the kind of its bound value", () => {
    const [command] = summary("Write-Output a -x:$y -z:1 -w:'q'").commands
    expect(command.arguments.map((argument) => argument.bound?.kind)).toEqual([
      undefined,
      "VariableExpressionAst",
      "ConstantExpressionAst",
      "StringConstantExpressionAst",
    ])
    expect(command.arguments[3].bound?.value).toBe("q")
  })

  test("a constant argument has its value with the quotes removed and a variable has none", () => {
    expect(summary("Remove-Item 'a b' $x").commands[0]?.arguments?.map((argument) => argument.value)).toEqual(["a b", undefined])
  })

  test("a command name written with a quote or backtick is the command", () => {
    expect(summary("& 'Remove-Item' a").commands[0].name).toBe("remove-item")
  })

  test("controls stay plain", () => {
    for (const text of ["Get-ChildItem", "Get-Date # comment", "Get-ChildItem | Select-Object -First 1", "Remove-Item -Recurse -Force x"]) {
      const result = summary(text)
      expect(result.statements.every((statement) => statement.top)).toBe(true)
      for (const statement of result.statements) {
        expect(statement).toMatchObject({
          memberAccess: false,
          subexpression: false,
          expandable: false,
          scriptBlock: false,
          assignment: false,
          redirects: [],
        })
      }
      expect(result.commands.every((command) => !command.nested)).toBe(true)
      expect([result.stopParsing, result.requires, result.variables, result.types, result.usings]).toEqual([
        false,
        false,
        [],
        [],
        [],
      ])
    }
  })

  test("a merge is separate from a file redirect and $null is a plain target", () => {
    expect(redirects("Write-Output a 2>&1")).toEqual([expect.objectContaining({ kind: "merge" })])
    expect(redirects("Write-Output a > $null")).toEqual([expect.objectContaining({ kind: "file", target: "$null" })])
  })

  test("statement flags", () => {
    expect(summary("$x = Get-Date").statements[0]).toMatchObject({ kind: "AssignmentStatementAst", assignment: true })
    expect(summary("Write-Output (1)").statements[0].subexpression).toBe(true)
    expect(summary("Write-Output $(1)").statements[0].subexpression).toBe(true)
    expect(summary('Write-Output "a $x"').statements[0].expandable).toBe(true)
    expect(summary("Get-ChildItem | ForEach-Object { $_ }").statements[0].scriptBlock).toBe(true)
  })

  test("a statement that is not a pipeline of commands is a placeholder named by its text", () => {
    const [statement] = summary("$x = Get-Date").statements
    expect(statement.elements).toHaveLength(1)
    expect(statement.elements[0].command).toMatchObject({ placeholder: true, name: "$x = Get-Date" })
    const [expression] = summary("'x' > f.txt").statements
    expect(expression.elements[0].command).toMatchObject({ placeholder: true, name: "'x' > f.txt" })
  })

  test("a pipeline element that is an expression or a group is marked as such", () => {
    expect(summary("(Get-Item a) | Get-Date").statements[0].elements.map((element) => element.kind)).toEqual([
      "parenthesized",
      "command",
    ])
    expect(summary("1 | Get-Date").statements[0].elements.map((element) => element.kind)).toEqual(["expression", "command"])
  })

  test("the script-level param block and the body of every named block are statements", () => {
    expect(summary("param($a = (Remove-Item x))\nGet-Date").statements.map((statement) => statement.kind)).toEqual([
      "PipelineAst",
      "ParamBlockAst",
    ])
    expect(summary("begin { Get-ChildItem } process { Get-ChildItem } end { Get-ChildItem }").statements).toHaveLength(3)
    expect(summary("trap { Remove-Item a }").statements.map((statement) => statement.kind)).toEqual(["TrapStatementAst"])
  })

  test("whole-input facts", () => {
    expect(summary("Write-Output $env:PATH").variables).toEqual([{ name: "env:PATH", scope: "env", splatted: false }])
    expect(summary("Write-Output @args").variables).toEqual([{ name: "args", scope: "", splatted: true }])
    expect(summary("[IO.StreamWriter]'f'").types).toEqual(["IO.StreamWriter"])
    expect(summary("'f' -as [IO.StreamWriter]").types).toEqual(["IO.StreamWriter"])
    expect(summary("#Requires -Version 3\nGet-Date").requires).toBe(true)
    expect(summary("using namespace System.IO\nGet-Date").usings).toEqual([{ kind: "Namespace", name: "System.IO" }])
    expect(summary("${alias:Get-Content} = 'Remove-Item'").variables).toEqual([
      { name: "alias:Get-Content", scope: "alias", splatted: false },
    ])
  })

  test.each(["echo --% x", "echo \u2013-% x", "echo \u2014\u2014% x", "echo \u2015\u2015% x"])(
    "stop-parsing %s",
    (text) => {
      expect(summary(text).stopParsing).toBe(true)
    },
  )

  test("one dash is not the stop-parsing token", () => {
    expect(summary("echo \u2014% x").stopParsing).toBe(false)
  })

  test.each([
    ["an unterminated string", 'Write-Output "unterminated'],
    ["an accessor without a member", "$x.\nRemove-Item victim"],
    ["a quoted command name followed by an argument", "'git' status"],
    ["a glued backtick and CR LF after a variable", "$x`\r\nRemove-Item b"],
  ])("%s is invalid with parse-errors", (_label, text) => {
    expect(realResult(text)).toEqual({ valid: false, reason: "parse-errors" })
  })

  // && is a parse error in Windows PowerShell 5.1. PowerShell 7 reads it as a pipeline chain, a statement whose element
  // is a placeholder with both commands nested in it.
  test("a pipeline chain operator is a parse error on 5.1 and a chain with both commands nested on 7", () => {
    const text = "Get-Date && Remove-Item a"
    const result = realResult(text)
    if (!PowerShellParse.findHost()?.match(/pwsh(\.exe)?$/i)) {
      expect(result).toEqual({ valid: false, reason: "parse-errors" })
      return
    }
    expect(result.valid).toBe(true)
    expect(commandNames(text)).toEqual(["get-date", "remove-item"])
    expect(summary(text).statements[0]).toMatchObject({ kind: "PipelineChainAst" })
    expect(summary(text).statements[0].elements[0].command.placeholder).toBe(true)
    expect(summary(text).commands.map((command) => command.nested)).toEqual([true, true])
  })

  // A module-qualified name keeps only what follows the last backslash, unless the text is a path (a drive, a UNC path,
  // .\ or ..\). The class stays application in every case because a backslash makes it a path for PowerShell 5.1.
  test.each([
    ["Hyper-V\\Remove-VM x", "remove-vm"],
    ["posh-git\\Remove-Item x", "remove-item"],
    ["a\\b\\Remove-Item x", "remove-item"],
    ["Foo\\rm x", "rm"],
    ["Microsoft.PowerShell.Management\\ls", "ls"],
    [".\\Remove-Item x", ".\\remove-item"],
    ["..\\a\\Remove-Item x", "..\\a\\remove-item"],
    ["\\\\host\\share\\Remove-Item x", "\\\\host\\share\\remove-item"],
    ["C:\\a\\Remove-Item x", "c:\\a\\remove-item"],
  ])("the name of %s is %s", (text, name) => {
    expect(summary(text).commands[0]).toMatchObject({ name, class: "application" })
  })

  // 150 levels of nested blocks parse well inside the default deadline (it took 3.8 s at 100 levels with a pass per flag, and timed out
  // at 150).
  test("deeply nested script blocks parse inside the deadline", () => {
    const result = realResult(nested(150))
    expect(result.valid).toBe(true)
    expect(result.valid && result.summary.commands.filter((command) => command.name === "get-date")).toHaveLength(1)
  })

  test("text that is empty has no statements", () => {
    expect(summary("")).toMatchObject({ statements: [], commands: [], variables: [], types: [], usings: [] })
  })

  test("a one-element and an empty list come back as lists", () => {
    const one = summary("Get-ChildItem")
    expect([one.statements.length, one.commands.length, one.commands[0].arguments.length]).toEqual([1, 1, 0])
  })

  test("a using module line is a fact and the module is not run", async () => {
    await using dir = await tmpdir()
    const marker = path.join(dir.path, "ran.txt")
    const module = path.join(dir.path, "evil.psm1")
    await Bun.write(module, `Set-Content -Path '${marker}' -Value ran\n`)
    const result = await parse(`using module ${module}\nGet-Date`)
    expect(result.valid && result.summary.usings).toEqual([{ kind: "Module", name: module }])
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("text with a quote and a newline is data, not script", async () => {
    await using dir = await tmpdir()
    const marker = path.join(dir.path, "ran.txt")
    const text = `'; Set-Content '${marker}' ran; '\n"; Set-Content '${marker}' ran; "`
    await parse(text)
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("non-ASCII text round-trips", async () => {
    const result = await parse("Write-Output 'h\u00e9llo \ud83d\ude00'")
    expect(result.valid && result.summary.commands[0].arguments[0].value).toBe("h\u00e9llo \ud83d\ude00")
  })

  // The widest text fits() allows, in single-byte and three-byte characters, goes through the real host: a cap set too
  // large would fail only in use, as a transient error that spawns again on every call.
  test.each([
    ["ASCII", "a", 1],
    ["CJK", "あ", 3],
  ])("the widest %s text that fits is parsed", async (_label, char, width) => {
    const head = "Write-Output "
    let low = 0
    let high = 20_000
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (PowerShellParse.fits(head + char.repeat(mid))) low = mid
      else high = mid - 1
    }
    expect(low * width).toBeGreaterThan(3_000)
    expect(PowerShellParse.fits(head + char.repeat(low + 1))).toBe(false)
    const result = await parse(head + char.repeat(low))
    expect(result.valid && result.summary.commands[0].arguments[0].value?.length).toBe(low)
  }, 30_000)

  test("inspect is scanned for a clean parse and opaque otherwise", async () => {
    const run = (text: string) =>
      Effect.runPromise(PowerShellInspect.inspect(text).pipe(Effect.provide(real)))
    expect((await run("Get-Date")).kind).toBe("scanned")
    expect(await run('Write-Output "unterminated')).toEqual({ kind: "opaque", reason: "parse-errors" })
  })
})

describe("PowerShellParse normalisation", () => {
  const empty = { errors: [], statements: [], commands: [], variables: [], types: [], stopParsing: false, usings: [], requires: false }
  const raw = (command: Record<string, unknown>) =>
    JSON.stringify({
      ...empty,
      // A one-element array arrives as the element itself, as Windows PowerShell 5.1 writes it.
      commands: { text: "", nested: false, arguments: [], redirects: [], ...command },
    })
  const only = (written: string, name: string | null = written) => {
    const result = PowerShellParse.interpret(0, raw({ written, name }))
    if (!result.valid) throw new Error(result.reason)
    return result.summary.commands[0]
  }

  test("a one-element object is read as a one-element array and a missing list as an empty one", () => {
    const result = PowerShellParse.interpret(0, raw({ written: "ls", name: "ls" }))
    expect(result.valid && result.summary.commands.map((command) => command.written)).toEqual(["ls"])
    expect(result.valid && result.summary.statements).toEqual([])
    expect(PowerShellParse.interpret(0, JSON.stringify({ stopParsing: false, requires: false })).valid).toBe(true)
  })

  test.each([
    ["Get-ChildItem", "get-childitem", "cmdlet"],
    ["GET-CHILDITEM", "get-childitem", "cmdlet"],
    ["ls", "get-childitem", "cmdlet"],
    ["gci", "get-childitem", "cmdlet"],
    ["cat", "get-content", "cmdlet"],
    ["rm", "remove-item", "cmdlet"],
    ["%", "foreach-object", "cmdlet"],
    ["?", "where-object", "cmdlet"],
    ["Microsoft.PowerShell.Management\\Get-ChildItem", "get-childitem", "application"],
    ["Microsoft.PowerShell.Utility\\Get-ChildItem", "get-childitem", "application"],
    ["Microsoft.PowerShell.Foo\\Get-ChildItem", "get-childitem", "application"],
    ["Foo.Bar\\Remove-Item", "remove-item", "application"],
    [".\\Remove-Item", ".\\remove-item", "application"],
    ["..\\Remove-Item", "..\\remove-item", "application"],
    ["C:\\Remove-Item", "c:\\remove-item", "application"],
    ["\\\\host\\Remove-Item", "\\\\host\\remove-item", "application"],
    ["Microsoft.PowerShell.Management\\ls", "ls", "application"],
    ["md", "new-item", "cmdlet"],
    ["mkdir", "new-item", "cmdlet"],
    ["ipmo", "import-module", "cmdlet"],
    ["sajb", "start-job", "cmdlet"],
    ["nsn", "new-pssession", "cmdlet"],
    ["etsn", "enter-pssession", "cmdlet"],
    ["exsn", "exit-pssession", "cmdlet"],
    ["gsn", "get-pssession", "cmdlet"],
    ["rsn", "remove-pssession", "cmdlet"],
    ["ogv", "out-gridview", "cmdlet"],
    ["epcsv", "export-csv", "cmdlet"],
    ["rp", "remove-itemproperty", "cmdlet"],
    ["cli", "clear-item", "cmdlet"],
    ["ci", "ci", "unknown"],
    ["git", "git", "unknown"],
    ["git.exe", "git", "application"],
    ["GIT.EXE", "git", "application"],
    ["tool.cmd", "tool", "application"],
    ["run.bat", "run", "application"],
    ["tool.com", "tool", "application"],
    ["Get-ChildItem.exe", "get-childitem", "application"],
    ["ls.exe", "ls", "application"],
    ["C:\\tools\\git.exe", "c:\\tools\\git.exe", "application"],
    ["./git", "./git", "application"],
    [".\\git", ".\\git", "application"],
    ["Foo\\Get-ChildItem", "get-childitem", "application"],
    ["Foo/Get-ChildItem", "foo/get-childitem", "application"],
    ["Get-Chi\u1e1bdItem", "get-chi\u1e1bditem", "application"],
    ["G\u0435t-Date", "g\u0435t-date", "application"],
    ["Get-Child*", "get-child*", "unknown"],
    ["constructor", "constructor", "unknown"],
    ["toString", "tostring", "unknown"],
  ])("name %s", (written, name, kind) => {
    expect(only(written)).toMatchObject({ name, class: kind })
  })

  test.each(["sc", "sort", "curl", "wget", "compare", "diff"])("the alias %s is not resolved", (alias) => {
    expect(only(alias)).toMatchObject({ name: alias, class: "unknown" })
  })

  test("a quoted name has its quotes removed", () => {
    expect(only("'Get-ChildItem'")).toMatchObject({ name: "get-childitem", class: "cmdlet" })
    expect(only('"ls"')).toMatchObject({ name: "get-childitem" })
  })

  test("a computed name stays as written and is unknown", () => {
    expect(only("$x", null)).toMatchObject({ name: "$x", class: "unknown" })
  })

  test("an application is never an alias target", () => {
    expect(only("ls.exe").name).not.toBe("get-childitem")
    expect(only("./ls").name).not.toBe("get-childitem")
  })

  test.each<[string, "&" | "." | undefined]>([
    ["Ampersand", "&"],
    ["Dot", "."],
    ["Unknown", undefined],
    ["&", undefined],
  ])("the parser's operator %s becomes %s", (given, expected) => {
    const result = PowerShellParse.interpret(0, raw({ written: "x", name: "x", operator: given }))
    expect(result.valid && result.summary.commands[0].operator).toBe(expected)
  })
})

// A host that is a function, so every way a run can end is a row.
type Step = { exit?: number; out?: string; fail?: true; hang?: true; delay?: number }

const ok = JSON.stringify({
  errors: [],
  statements: [],
  commands: [],
  variables: [],
  types: [],
  stopParsing: false,
  usings: [],
  requires: false,
})

function fake(steps: (attempt: number) => Step) {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; cwd?: string; stdin?: unknown }> = []
  const spawner = make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("piped command")
    calls.push({ command: command.command, args: command.args, cwd: command.options.cwd, stdin: command.options.stdin })
    const step = steps(calls.length)
    if (step.fail)
      return Effect.fail(
        PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn", description: "no host" }),
      )
    const wait = step.delay ? Effect.sleep(Duration.millis(step.delay)) : Effect.void
    return Effect.succeed(
      makeHandle({
        pid: ProcessId(calls.length),
        exitCode: step.hang ? Effect.never : wait.pipe(Effect.as(ExitCode(step.exit ?? 0))),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: step.hang ? Stream.never : Stream.fromEffect(wait.pipe(Effect.as(new TextEncoder().encode(step.out ?? "")))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  const layer = (options: PowerShellParse.Options = {}) =>
    Layer.provide(
      PowerShellParse.layerWith({ host: () => "/fake/pwsh", timeout: Duration.millis(100), ...options }),
      Layer.succeed(ChildProcessSpawner, spawner),
    )
  return { calls, layer }
}

describe("PowerShellParse fails closed", () => {
  test("a missing host is no-host and nothing starts", async () => {
    const host = fake(() => ({ out: ok }))
    expect(await parse("Get-Date", host.layer({ host: () => undefined }))).toEqual({ valid: false, reason: "no-host" })
    expect(host.calls).toHaveLength(0)
  })

  test("a spawn error is spawn and is not retried", async () => {
    const host = fake(() => ({ fail: true }))
    expect(await parse("Get-Date", host.layer())).toEqual({ valid: false, reason: "spawn" })
    expect(host.calls).toHaveLength(1)
  })

  test("a timeout is retried once and then is timeout", async () => {
    const host = fake(() => ({ hang: true }))
    const started = Date.now()
    expect(await parse("Get-Date", host.layer())).toEqual({ valid: false, reason: "timeout" })
    expect(host.calls).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 15_000)

  test("a timeout that the retry beats is a result", async () => {
    const host = fake((attempt) => (attempt === 1 ? { hang: true } : { out: ok }))
    expect((await parse("Get-Date", host.layer())).valid).toBe(true)
    expect(host.calls).toHaveLength(2)
  }, 15_000)

  test("the timeout comes from ORBIT_PWSH_PARSE_TIMEOUT_MS", async () => {
    const before = process.env.ORBIT_PWSH_PARSE_TIMEOUT_MS
    process.env.ORBIT_PWSH_PARSE_TIMEOUT_MS = "60"
    try {
      const host = fake(() => ({ hang: true }))
      const started = Date.now()
      expect(await parse("Get-Date", host.layer({ timeout: undefined }))).toEqual({ valid: false, reason: "timeout" })
      expect(host.calls).toHaveLength(2)
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      if (before === undefined) delete process.env.ORBIT_PWSH_PARSE_TIMEOUT_MS
      else process.env.ORBIT_PWSH_PARSE_TIMEOUT_MS = before
    }
  }, 15_000)

  test("a non-zero exit is exit and is not retried", async () => {
    const host = fake(() => ({ exit: 1, out: ok }))
    expect(await parse("Get-Date", host.layer())).toEqual({ valid: false, reason: "exit" })
    expect(host.calls).toHaveLength(1)
  })

  test("empty output is empty", async () => {
    expect(await parse("Get-Date", fake(() => ({ out: "  \r\n" })).layer())).toEqual({ valid: false, reason: "empty" })
  })

  test.each(["not json", "{", "[]", "null", '{"errors":[]}', '{"stopParsing":"yes","requires":false}'])(
    "output %s is json",
    async (out) => {
      expect(await parse("Get-Date", fake(() => ({ out })).layer())).toEqual({ valid: false, reason: "json" })
    },
  )

  test("parse errors in a well-formed summary are parse-errors", async () => {
    const out = JSON.stringify({ ...JSON.parse(ok), errors: ["Unexpected token"] })
    expect(await parse("Get-Date", fake(() => ({ out })).layer())).toEqual({ valid: false, reason: "parse-errors" })
    // A single error comes as a plain string from Windows PowerShell 5.1.
    const single = JSON.stringify({ ...JSON.parse(ok), errors: "Unexpected token" })
    expect(await parse("Get-Date", fake(() => ({ out: single })).layer())).toEqual({ valid: false, reason: "parse-errors" })
  })

  test("a text over the cap is too-long and is never truncated or sent", async () => {
    const host = fake(() => ({ out: ok }))
    const text = "Write-Output " + "a".repeat(40_000)
    expect(await parse(text, host.layer())).toEqual({ valid: false, reason: "too-long" })
    expect(host.calls).toHaveLength(0)
  })

  test("the cap is derived from the command line limit on Windows and fixed elsewhere", () => {
    expect(PowerShellParse.fits("a".repeat(4_500), "linux")).toBe(true)
    expect(PowerShellParse.fits("a".repeat(4_501), "linux")).toBe(false)
    expect(PowerShellParse.fits("a".repeat(3_000), "win32")).toBe(true)
    expect(PowerShellParse.fits("a".repeat(5_000), "win32")).toBe(false)
    const widest = Array.from({ length: 6_000 }, (_, size) => size).findLast((size) => PowerShellParse.fits("a".repeat(size), "win32"))!
    // The encoded command that the largest allowed text produces fits in the system limit with room for the host path.
    expect(PowerShellParse.encodedLength(widest)).toBeLessThanOrEqual(32_767 - 400)
    expect(PowerShellParse.encodedLength(widest + 1)).toBeGreaterThan(32_767 - 400)
  })

  test("the size is measured in UTF-8 bytes, not characters", () => {
    expect(PowerShellParse.fits("\u754c".repeat(2_000), "win32")).toBe(false)
    expect(PowerShellParse.fits("a".repeat(2_000), "win32")).toBe(true)
    expect(PowerShellParse.fits("\u754c".repeat(2_000), "linux")).toBe(false)
    expect(PowerShellParse.fits("a".repeat(2_000), "linux")).toBe(true)
  })

  test("the encoded command has the length that the cap assumes and carries the text as data", async () => {
    const host = fake(() => ({ out: ok }))
    const text = "Write-Output 'x'; Remove-Item \"y\" # \u00e9"
    await parse(text, host.layer())
    const [call] = host.calls
    expect(call.command).toBe("/fake/pwsh")
    expect(call.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand"])
    const encoded = call.args[4]
    expect(encoded).toHaveLength(PowerShellParse.encodedLength(Buffer.byteLength(text)))
    const script = Buffer.from(encoded, "base64").toString("utf16le")
    expect(script).toContain(Buffer.from(text).toString("base64"))
    expect(script).not.toContain("Remove-Item")
    expect(script).not.toContain("__TEXT__")
  })

  test("the host starts in a neutral folder with nothing on stdin", async () => {
    const host = fake(() => ({ out: ok }))
    await parse("Get-Date", host.layer())
    expect(host.calls[0].cwd).toBe(os.tmpdir())
    expect(host.calls[0].cwd).not.toBe(process.cwd())
    expect(host.calls[0].stdin).toBe("ignore")
  })

  test("inspect is opaque with the reason of every failure", async () => {
    const run = (host: ReturnType<typeof fake>, options?: PowerShellParse.Options) =>
      Effect.runPromise(PowerShellInspect.inspect("Get-Date").pipe(Effect.provide(host.layer(options))))
    expect(await run(fake(() => ({ out: ok })))).toMatchObject({ kind: "scanned" })
    expect(await run(fake(() => ({ out: ok })), { host: () => undefined })).toEqual({ kind: "opaque", reason: "no-host" })
    expect(await run(fake(() => ({ fail: true })))).toEqual({ kind: "opaque", reason: "spawn" })
    expect(await run(fake(() => ({ hang: true })))).toEqual({ kind: "opaque", reason: "timeout" })
    expect(await run(fake(() => ({ exit: 2 })))).toEqual({ kind: "opaque", reason: "exit" })
    expect(await run(fake(() => ({ out: "" })))).toEqual({ kind: "opaque", reason: "empty" })
    expect(await run(fake(() => ({ out: "}" })))).toEqual({ kind: "opaque", reason: "json" })
  }, 15_000)
})

describe("PowerShellParse cache", () => {
  test("concurrent identical calls share one process", async () => {
    const shared = fake(() => ({ out: ok, delay: 50 }))
    const layer = shared.layer()
    const all = await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        return yield* Effect.all(
          Array.from({ length: 8 }, () => parser.parse("Get-Date")),
          { concurrency: "unbounded" },
        )
      }).pipe(Effect.provide(layer)),
    )
    expect(all.every((result) => result.valid)).toBe(true)
    expect(shared.calls).toHaveLength(1)
  })

  test("different texts do not share", async () => {
    const host = fake(() => ({ out: ok }))
    await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        yield* parser.parse("Get-Date")
        yield* parser.parse("Get-Date ")
      }).pipe(Effect.provide(host.layer())),
    )
    expect(host.calls).toHaveLength(2)
  })

  test("a finished clean result is kept", async () => {
    const host = fake(() => ({ out: ok }))
    await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        yield* parser.parse("Get-Date")
        yield* parser.parse("Get-Date")
      }).pipe(Effect.provide(host.layer())),
    )
    expect(host.calls).toHaveLength(1)
  })

  test("a deterministic failure is kept", async () => {
    const out = JSON.stringify({ ...JSON.parse(ok), errors: ["x"] })
    const host = fake(() => ({ out }))
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        return [yield* parser.parse("$x."), yield* parser.parse("$x.")]
      }).pipe(Effect.provide(host.layer())),
    )
    expect(results).toEqual([
      { valid: false, reason: "parse-errors" },
      { valid: false, reason: "parse-errors" },
    ])
    expect(host.calls).toHaveLength(1)
  })

  test("too-long is kept without ever starting a process", async () => {
    const host = fake(() => ({ out: ok }))
    const text = "a".repeat(40_000)
    await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        yield* parser.parse(text)
        yield* parser.parse(text)
      }).pipe(Effect.provide(host.layer())),
    )
    expect(host.calls).toHaveLength(0)
  })

  test.each<[PowerShellParse.Reason, Step]>([
    ["spawn", { fail: true }],
    ["exit", { exit: 3 }],
    ["empty", { out: "" }],
    ["json", { out: "nope" }],
    ["timeout", { hang: true }],
  ])("a transient %s is not kept", async (reason, bad) => {
    const host = fake((attempt) => (attempt <= (reason === "timeout" ? 2 : 1) ? bad : { out: ok }))
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        return [yield* parser.parse("Get-Date"), yield* parser.parse("Get-Date")]
      }).pipe(Effect.provide(host.layer())),
    )
    expect(results[0]).toEqual({ valid: false, reason })
    expect(results[1].valid).toBe(true)
  }, 15_000)

  test("a cache hit refreshes the entry, so the one just used outlives the oldest", async () => {
    const host = fake(() => ({ out: ok }))
    await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        for (let index = 0; index < 256; index++) yield* parser.parse(`Write-Output ${index}`)
        yield* parser.parse("Write-Output 0")
        yield* parser.parse("Write-Output 256")
        // 1 was the oldest and is gone; 0 was used last and is held.
        yield* parser.parse("Write-Output 0")
      }).pipe(Effect.provide(host.layer())),
    )
    expect(host.calls).toHaveLength(257)
  })

  test("a missing host is not kept", async () => {
    let present: string | undefined
    const host = fake(() => ({ out: ok }))
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        const first = yield* parser.parse("Get-Date")
        present = "/fake/pwsh"
        return [first, yield* parser.parse("Get-Date")]
      }).pipe(Effect.provide(host.layer({ host: () => present }))),
    )
    expect(results[0]).toEqual({ valid: false, reason: "no-host" })
    expect(results[1].valid).toBe(true)
  })

  test("the cache holds 256 texts and drops the oldest", async () => {
    const host = fake(() => ({ out: ok }))
    await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        for (let index = 0; index < 257; index++) yield* parser.parse(`Write-Output ${index}`)
        // 1..256 are still held and 0 was dropped.
        yield* parser.parse("Write-Output 256")
        yield* parser.parse("Write-Output 0")
      }).pipe(Effect.provide(host.layer())),
    )
    expect(host.calls).toHaveLength(258)
  })
})

describe("PowerShellParse failures that are not typed", () => {
  test("a spawner that dies is spawn, not a call that never ends, and is not kept", async () => {
    const calls: string[] = []
    const dying = make(() => {
      calls.push("spawn")
      return Effect.die(new Error("launch threw"))
    })
    const layer = Layer.provide(
      PowerShellParse.layerWith({ host: () => "/fake/pwsh", timeout: Duration.millis(100) }),
      Layer.succeed(ChildProcessSpawner, dying),
    )
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        return [yield* parser.parse("Get-Date"), yield* parser.parse("Get-Date")]
      }).pipe(Effect.provide(layer), Effect.timeout(Duration.seconds(3))),
    )
    expect(results).toEqual([
      { valid: false, reason: "spawn" },
      { valid: false, reason: "spawn" },
    ])
    expect(calls).toHaveLength(2)
  })
})

describe("PowerShellParse host lookup", () => {
  test("a link that points at the snap shim is the shim, a plain path is kept, and the real binary is the fallback", () => {
    const real = (file: string) => (file === "/usr/bin/pwsh" ? "/snap/bin/pwsh" : file)
    const exists = (file: string) => file === "/opt/microsoft/powershell/7/pwsh"
    expect(PowerShellParse.usableHost("/usr/bin/pwsh", { platform: "linux", real, exists })).toBe("/opt/microsoft/powershell/7/pwsh")
    expect(PowerShellParse.usableHost("/usr/bin/pwsh", { platform: "linux", real, exists: () => false })).toBeNull()
    expect(PowerShellParse.usableHost("/usr/local/bin/pwsh", { platform: "linux", real, exists })).toBe("/usr/local/bin/pwsh")
    expect(PowerShellParse.usableHost("/snap/bin/pwsh", { platform: "linux", exists })).toBe("/opt/microsoft/powershell/7/pwsh")
    // Nothing on PATH is no host, even when a real binary sits at a fixed path: the fixed paths only get past a launcher.
    expect(PowerShellParse.usableHost(null, { platform: "linux", real, exists })).toBeNull()
    expect(PowerShellParse.usableHost("C:\\pwsh.exe", { platform: "win32" })).toBe("C:\\pwsh.exe")
  })

  test("hostFrom falls back to the real binary when PATH holds a link to the snap shim", () => {
    const real = (file: string) => (file === "/usr/bin/pwsh" ? "/snap/bin/pwsh" : file)
    const exists = (file: string) => file === "/opt/microsoft/powershell/7/pwsh"
    const lookup = (name: string) => (name === "pwsh" ? "/usr/bin/pwsh" : null)
    expect(PowerShellParse.hostFrom(lookup, { platform: "linux", real, exists })).toBe("/opt/microsoft/powershell/7/pwsh")
    expect(PowerShellParse.hostFrom(lookup, { platform: "linux", real: (file) => file, exists })).toBe("/usr/bin/pwsh")
    expect(PowerShellParse.hostFrom((name) => (name === "powershell" ? "C:\\ps.exe" : null), { platform: "win32" })).toBe("C:\\ps.exe")
    expect(PowerShellParse.hostFrom((name) => (name === "powershell" ? "/x/powershell" : null), { platform: "linux", exists: () => false })).toBeNull()
  })

  test("a snap launcher is not a usable host", () => {
    expect(PowerShellParse.isLauncher("/snap/bin/pwsh", "linux")).toBe(true)
    expect(PowerShellParse.isLauncher("/usr/bin/pwsh", "linux")).toBe(false)
    expect(PowerShellParse.isLauncher("/snap/bin/pwsh", "win32")).toBe(false)
  })
})

// Class 10. Windows looks in the working folder before PATH for a program started by its name, and a repository chooses
// what its folder holds, so the host must come from PATH only and must start by its full path.
describe("PowerShellParse never starts a program from the working folder", () => {
  const before = { cwd: process.cwd(), path: process.env.PATH, pathWindows: process.env.Path }
  afterAll(() => {
    process.chdir(before.cwd)
    PowerShellParse.forgetHost()
  })

  async function decoys(directory: string) {
    const ran = path.join(directory, "ran.txt")
    if (process.platform === "win32") {
      const planted = await plant(directory, "pwsh", "powershell")
      await fs.writeFile(path.join(directory, "pwsh.bat"), `@echo off\r\necho bat>> "${ran}"\r\n`)
      await fs.writeFile(path.join(directory, "powershell.cmd"), `@echo off\r\necho cmd>> "${ran}"\r\n`)
      return async () => [...(await planted()), ...(await Bun.file(ran).exists() ? (await Bun.file(ran).text()).split(/\r?\n/).filter(Boolean) : [])]
    }
    for (const name of ["pwsh", "powershell"]) {
      await fs.writeFile(path.join(directory, name), `#!/bin/sh\necho ${name}>> "${ran}"\n`, { mode: 0o755 })
    }
    return async () => ((await Bun.file(ran).exists()) ? (await Bun.file(ran).text()).split(/\r?\n/).filter(Boolean) : [])
  }

  test.skipIf(!hasHost)(
    "the real parser runs from PATH while decoys sit in the working folder",
    async () => {
      await using dir = await tmpdir()
      const ran = await decoys(dir.path)
      using _ = currentDirectoryOnPath()
      process.chdir(dir.path)
      PowerShellParse.forgetHost()
      try {
        const result = await parse("Get-Date")
        expect(result.valid).toBe(true)
        expect(PowerShellParse.findHost()).not.toStartWith(dir.path)
      } finally {
        process.chdir(before.cwd)
        PowerShellParse.forgetHost()
      }
      expect(await ran()).toEqual([])
    },
    60_000,
  )

  test(
    "with no PowerShell on PATH the answer is no-host and no decoy runs",
    async () => {
      await using dir = await tmpdir()
      await using empty = await tmpdir()
      const ran = await decoys(dir.path)
      using _ = currentDirectoryOnPath()
      process.chdir(dir.path)
      process.env.PATH = empty.path
      process.env.Path = empty.path
      PowerShellParse.forgetHost()
      try {
        expect(await parse("Get-Date")).toEqual({ valid: false, reason: "no-host" })
      } finally {
        process.chdir(before.cwd)
        process.env.PATH = before.path
        if (before.pathWindows === undefined) delete process.env.Path
        else process.env.Path = before.pathWindows
        PowerShellParse.forgetHost()
      }
      expect(await ran()).toEqual([])
    },
    60_000,
  )

  // Without this the rows above would pass with decoys that cannot run.
  test(
    "control: the decoys do run when started by their path",
    async () => {
      await using dir = await tmpdir()
      const ran = await decoys(dir.path)
      const program = process.platform === "win32" ? "pwsh.exe" : "pwsh"
      await Bun.spawn([path.join(dir.path, program)], { cwd: dir.path, stdout: "ignore", stderr: "ignore" }).exited
      expect((await ran()).length).toBeGreaterThan(0)
    },
    60_000,
  )
})
