import { describe, expect, test } from "bun:test"
import { ShellScan } from "../../src/shell/scan"

function scanned(input: string) {
  const result = ShellScan.inspect(input, "powershell")
  if (result.kind !== "scanned") throw new Error(`opaque: ${result.reason} (${result.class})`)
  return result
}

function only(input: string) {
  const result = scanned(input)
  expect(result.commands).toHaveLength(1)
  return result.commands[0]
}

function statement(input: string) {
  const result = scanned(input)
  expect(result.statements).toHaveLength(1)
  return result.statements[0]
}

describe("ShellScan.inspect powershell redirects", () => {
  test.each([
    ["Get-Date > out", ">", undefined, "out"],
    ["Get-Date >> out", ">>", undefined, "out"],
    ["Get-Date 2> err", ">", "2", "err"],
    ["Get-Date 2>> err", ">>", "2", "err"],
    ["Get-Date *> all", ">", "*", "all"],
    ["Get-Date 6> nine", ">", "6", "nine"],
  ])("%s", (input, operator, fd, target) => {
    const redirect = only(input).redirects[0]
    expect(redirect).toMatchObject({ operator, target, raw: target, write: true, dynamic: false, nullSink: false })
    expect(redirect.fd).toBe(fd)
  })

  test.each(["2>&1", "3>&1", "6>&1", "*>&1"])("%s is a merge without a target", (merge) => {
    const command = only(`Get-Date ${merge}`)
    expect(command.words).toEqual(["Get-Date"])
    expect(command.redirects).toHaveLength(1)
    expect(command.redirects[0]).toMatchObject({
      operator: ">&",
      raw: merge.slice(-1),
      write: false,
      dynamic: false,
      nullSink: false,
    })
    expect(command.redirects[0].target).toBeUndefined()
  })

  test("a $null target is a null sink, not a write to an unknown path", () => {
    for (const input of ["Get-Date 2>$null", "Get-Date > $null", "Get-Date *> $NULL"]) {
      expect(only(input).redirects[0]).toMatchObject({ nullSink: true, dynamic: false, write: true })
    }
    expect(only("Get-Date > $nullable").redirects[0]).toMatchObject({ nullSink: false, dynamic: true })
    expect(only("Get-Date > '$null'").redirects[0]).toMatchObject({ nullSink: false, dynamic: false })
  })

  test("targets are unquoted and a computed target is flagged dynamic", () => {
    expect(only(`Get-Date > "a b"`).redirects[0]).toMatchObject({ target: "a b", raw: '"a b"', dynamic: false })
    expect(only("Get-Date > $HOME/f").redirects[0].dynamic).toBe(true)
    expect(only("Get-Date > $env:TEMP/f").redirects[0].dynamic).toBe(true)
    expect(only("Get-Date > $(Join-Path a b)").redirects[0].dynamic).toBe(true)
    expect(only("Get-Date > (Join-Path a b)").redirects[0].dynamic).toBe(true)
    expect(only("Get-Date > *.log").redirects[0].dynamic).toBe(true)
    expect(only("Get-Date > ~/f").redirects[0].dynamic).toBe(true)
    expect(only("Get-Date > '$HOME'").redirects[0].dynamic).toBe(false)
  })

  test("redirects belong to their own command in a list and a pipeline", () => {
    const { commands } = scanned("Get-Date > a; Get-Item x | Out-File b 2> c")
    expect(commands.map((command) => command.redirects.map((redirect) => redirect.target))).toEqual([["a"], [], ["c"]])
  })

  // Windows PowerShell 5.1 ends an expression token at ">" and does not end a generic argument there:
  // `Write-Output a>f` prints "a>f" and creates no file, while `$v>f` writes f.
  test.each([
    ["$v>f", ">", "f"],
    ["$v>>f", ">>", "f"],
    ["${v}>f", ">", "f"],
    ["$(Get-Date)>f", ">", "f"],
    ["@(1)>f", ">", "f"],
    ["$x.Length>f", ">", "f"],
    ["$x[0]>f", ">", "f"],
    ["$v>'f g'", ">", "f g"],
    ['$v>"f g"', ">", "f g"],
  ])("a > ends an expression token: %s", (input, operator, target) => {
    const result = scanned(input)
    expect(result.statements.flatMap((item) => item.redirects)).toMatchObject([{ operator, target, write: true }])
  })

  // Each row wrote a file outside the working folder in Windows PowerShell 5.1. The glued target must read the
  // same as the spaced one, which decodes escapes and flags expansions.
  test.each([
    [String.raw`$v>${"$"}{env:R74}\escape-env.txt`, String.raw`${"$"}{env:R74}\escape-env.txt`, true],
    ["$v>.`.`/escape-backtick.txt", "../escape-backtick.txt", false],
    ["$v>..`\\escape-backslash.txt", "..\\escape-backslash.txt", false],
    [String.raw`$(Get-Date)>${"$"}{HOME}\.ssh\authorized_keys`, String.raw`${"$"}{HOME}\.ssh\authorized_keys`, true],
    ["$v>$HOME/f", "$HOME/f", true],
    ["$v>(Join-Path a b)", "(Join-Path a b)", true],
    ["$v>*.log", "*.log", true],
    ["$v>~/f", "~/f", true],
    ["$v>$null", "$null", false],
  ])("a glued target reads like a spaced one: %s", (glued, target, dynamic) => {
    const spaced = glued.replace(">", " > ")
    for (const input of [glued, spaced]) {
      const redirects = scanned(input).statements.flatMap((item) => item.redirects)
      expect(redirects).toHaveLength(1)
      expect(redirects[0].dynamic).toBe(target === "$null" ? false : dynamic)
      expect(redirects[0].target).toBe(target)
    }
  })

  test.each([
    "Write-Output a>f",
    "Write-Output a>>f",
    "Write-Output a> f",
    'Write-Output a>"f g"',
    "Write-Output a>$p",
    "Write-Output a$env:OS>f",
    "Write-Output a<#b#> x",
  ])("a > inside a generic argument is text: %s", (input) => {
    expect(only(input).redirects).toEqual([])
  })

  test("a missing target is opaque syntax", () => {
    expect(ShellScan.inspect("Get-Date >", "powershell")).toMatchObject({
      kind: "opaque",
      reason: "invalid-structure",
      class: "syntax",
    })
  })
})

describe("ShellScan.inspect powershell expression statements", () => {
  test.each([
    ["'x' > ../o/f", ">", "../o/f"],
    ['"x" >> ../o/f', ">>", "../o/f"],
    ["$k >> $HOME/.ssh/authorized_keys", ">>", "$HOME/.ssh/authorized_keys"],
    ["$(Get-Date) *> f", ">", "f"],
    ["(Get-Date) > f", ">", "f"],
    ["@(1, 2) > f", ">", "f"],
    ["[int]5 > f", ">", "f"],
    ["@'\nbody\n'@ > f", ">", "f"],
    ['@"\nbody\n"@ > f', ">", "f"],
    ["$x.Length > f", ">", "f"],
  ])("%j writes at the top level", (input, operator, target) => {
    const result = scanned(input)
    // Only a subexpression's own commands are promoted to the top level; the statement itself runs no command.
    expect(result.commands.filter((command) => !command.origin)).toEqual([])
    const entry = result.statements.find((item) => item.redirects.length)
    expect(entry?.redirects[0]).toMatchObject({ operator, target, write: true })
  })

  test("a statement after an expression statement keeps its own redirects", () => {
    const result = scanned("'x' > a; Get-Date > b")
    expect(result.statements.map((item) => item.redirects.map((redirect) => redirect.target))).toEqual([["a"]])
    expect(result.commands.map((item) => item.redirects.map((redirect) => redirect.target))).toEqual([["b"]])
  })

  test.each(["$x.Length", "'x'", "[Environment]::CurrentDirectory", "$(1)", "(1)", "@{a=1}", "5", "[int]"])(
    "an expression statement with nothing to report is still an entry: %s",
    (input) => {
      const result = scanned(input)
      expect(result.commands).toEqual([])
      // A subexpression's own expression statements follow the outer one.
      expect(result.statements.length).toBeGreaterThanOrEqual(1)
      expect(result.statements[0]).toMatchObject({ redirects: [], invocations: [] })
      expect(result.statements[0].origin).toBeUndefined()
    },
  )

  test("a command or a compound statement is not an expression entry", () => {
    expect(scanned("Get-Date").statements).toEqual([])
    expect(scanned("if ($x) { Get-Date }").statements.filter((item) => !item.origin)).toEqual([])
    expect(scanned("$x = Get-Date").statements).toEqual([])
  })

  test("the grouped command of an expression statement stays nested", () => {
    const entry = statement("(Get-Date) > f")
    expect(entry.nested.map((node) => [node.words, node.origin])).toEqual([[["Get-Date"], "group"]])
  })
})

describe("ShellScan.inspect powershell origins", () => {
  test("a script block is a block", () => {
    const command = only("ForEach-Object { Remove-Item $_ }")
    expect(command.nested.map((node) => [node.words, node.origin])).toEqual([[["Remove-Item", "$_"], "block"]])
  })

  test("a subexpression is a subexpression", () => {
    const command = only("Write-Output $(Remove-Item x)")
    expect(command.nested.map((node) => [node.words, node.origin])).toEqual([[["Remove-Item", "x"], "subexpression"]])
  })

  test("an array subexpression is a subexpression", () => {
    const command = only("Write-Output @(Remove-Item x)")
    expect(command.nested.map((node) => node.origin)).toEqual(["subexpression"])
  })

  test("a group is a group, not a substitution", () => {
    const command = only("Write-Output (Join-Path a b)")
    expect(command.nested.map((node) => [node.words, node.origin])).toEqual([[["Join-Path", "a", "b"], "group"]])
  })

  test("a hashtable value is a block", () => {
    const command = only("Write-Output @{ a = Get-Item x }")
    expect(command.nested.map((node) => [node.words, node.origin])).toEqual([[["Get-Item", "x"], "block"]])
  })

  test("subexpressions inside expandable strings and here-strings are subexpressions", () => {
    for (const input of ['Write-Output "a $(Remove-Item x) b"', 'Write-Output @"\na $(Remove-Item x)\n"@']) {
      expect(only(input).nested.map((node) => [node.words[0], node.origin])).toEqual([["Remove-Item", "subexpression"]])
    }
    // Single-quoted text is literal.
    expect(only("Write-Output '$(Remove-Item x)'").nested).toEqual([])
  })

  test("nested origins are the innermost construct", () => {
    const command = only("ForEach-Object { Write-Output $(Remove-Item (Join-Path a b)) }")
    const block = command.nested[0]
    expect(block.origin).toBe("block")
    expect(block.nested[0].origin).toBe("subexpression")
    expect(block.nested[0].nested[0].origin).toBe("group")
  })

  test("the flat legacy list still holds every nested command", () => {
    const result = ShellScan.scanPowerShell("ForEach-Object { Write-Output $(Remove-Item x) }")
    expect(result.kind === "scanned" && result.commands.map((command) => command.words[0])).toEqual([
      "ForEach-Object",
      "Write-Output",
      "Remove-Item",
    ])
  })
})

describe("ShellScan.inspect powershell invocations", () => {
  test("a static call reports the type and the member", () => {
    expect(statement("[IO.File]::WriteAllText('a','b')").invocations).toEqual([
      { kind: "static", type: "IO.File", member: "WriteAllText" },
    ])
    expect(only("Write-Output [System.IO.Directory]::Delete('a')").invocations).toEqual([
      { kind: "static", type: "System.IO.Directory", member: "Delete" },
    ])
  })

  test("a static property read is not an invocation", () => {
    expect(scanned("[Environment]::CurrentDirectory").statements[0].invocations).toEqual([])
  })

  test("an instance call reports the member", () => {
    expect(statement("(Get-Item a).Delete()").invocations).toEqual([{ kind: "instance", member: "Delete" }])
    expect(statement("$x.Delete()").invocations).toEqual([{ kind: "instance", member: "Delete" }])
    expect(statement("'abc'.ToUpper().Trim()").invocations).toEqual([
      { kind: "instance", member: "ToUpper" },
      { kind: "instance", member: "Trim" },
    ])
    expect(statement("$a.b.Delete()").invocations).toEqual([{ kind: "instance", member: "Delete" }])
  })

  test("a property read reports none", () => {
    expect(statement("$x.Length").invocations).toEqual([])
    expect(only("Write-Output $x.Length").invocations).toEqual([])
    expect(only("Write-Output 1..3 .5 a.b").invocations).toEqual([])
  })

  test("a computed member or type is reported as dynamic", () => {
    expect(statement("$x.$name()").invocations).toEqual([{ kind: "instance", member: "", dynamic: true }])
    expect(statement("$x.('De'+'lete')()").invocations).toEqual([{ kind: "instance", member: "", dynamic: true }])
    expect(statement("$x.'Delete'()").invocations).toEqual([{ kind: "instance", member: "", dynamic: true }])
    expect(statement("[IO.File]::$m('a')").invocations).toEqual([
      { kind: "static", type: "IO.File", member: "", dynamic: true },
    ])
    expect(statement("$t::Delete('a')").invocations).toEqual([
      { kind: "static", type: "$t", member: "Delete", dynamic: true },
    ])
  })

  test("calls inside a string, a comment or a nested block belong elsewhere", () => {
    expect(only("Write-Output 'x.Delete()'").invocations).toEqual([])
    expect(only('Write-Output "x.Delete()"').invocations).toEqual([])
    expect(only("Write-Output a # $x.Delete()").invocations).toEqual([])
    const command = only("ForEach-Object { $_.Delete() }")
    expect(command.invocations).toEqual([])
    expect(command.nested[0].invocations).toEqual([{ kind: "instance", member: "Delete" }])
    const inner = only("Write-Output $([IO.File]::Delete('a'))")
    expect(inner.invocations).toEqual([])
    expect(inner.nested[0].invocations).toEqual([{ kind: "static", type: "IO.File", member: "Delete" }])
  })

  test("an env: read is reported, also inside double quotes", () => {
    expect(only("Write-Output $env:HOME").invocations).toEqual([{ kind: "env", name: "HOME" }])
    expect(only("Write-Output ${env:Path}").invocations).toEqual([{ kind: "env", name: "Path" }])
    expect(only('Write-Output "$env:HOME/x"').invocations).toEqual([{ kind: "env", name: "HOME" }])
    expect(only("Write-Output '$env:HOME'").invocations).toEqual([])
  })

  test.each([
    ['Write-Output @"\n$env:R74S\n"@', ["R74S"]],
    ['Write-Output @"\na ${env:R74S} b $env:Path\n"@', ["R74S", "Path"]],
    ['@"\n$env:R74S\n"@ > f', ["R74S"]],
    ['Write-Output @"\n$($env:Inner)\n"@', []],
    ['Write-Output @"\n`$env:Escaped\n"@', []],
    ["Write-Output @'\n$env:R74S\n'@", []],
    ["cmd --% /c echo %R74S% %Path%", ["R74S", "Path"]],
  ])("env reads in here-strings and after --%%: %j", (input, names) => {
    const result = scanned(input)
    const invocations = [...result.commands, ...result.statements].flatMap((item) => item.invocations)
    expect(invocations.flatMap((item) => (item.kind === "env" ? [item.name] : []))).toEqual(names)
  })

  test.each<[string, ShellScan.Invocation]>([
    ["[Array]::Empty[int]()", { kind: "static", type: "Array", member: "Empty" }],
    ["[Array]::Empty[System.Collections.Generic.List[int]]()", { kind: "static", type: "Array", member: "Empty" }],
    ["$list.ConvertAll[string]({ $_ })", { kind: "instance", member: "ConvertAll" }],
    ["$t::Make[int]()", { kind: "static", type: "$t", member: "Make", dynamic: true }],
  ])("a generic method call is reported: %s", (input, invocation) => {
    expect(scanned(input).statements[0].invocations).toContainEqual(invocation)
  })

  test("the method call on the right of an assignment is reported", () => {
    const result = scanned("$p = [IO.Path]::GetTempPath()")
    expect(result.statements.flatMap((item) => item.invocations)).toEqual([
      { kind: "static", type: "IO.Path", member: "GetTempPath" },
    ])
  })
})

describe("ShellScan.inspect powershell words", () => {
  test("expansion flags, quoted and unquoted", () => {
    const command = only(`Write-Output $a "$b" \${c} $env:D $(e) @(f) (g) 'h$i' "\`$j" "$(k)" ~ ~/x '~' $_ $? $1`)
    expect(command.flags).toEqual([
      {},
      { parameter: true },
      { parameter: true },
      { parameter: true },
      { parameter: true },
      { command: true },
      { command: true },
      { command: true },
      {},
      {},
      { command: true },
      { tilde: true },
      { tilde: true },
      { tilde: true },
      { parameter: true },
      { parameter: true },
      { parameter: true },
    ])
  })

  test("wildcards are unquoted only", () => {
    const flags = only(`Remove-Item *.c a?b [ab].c "*" '?' \`* -Path:*`).flags
    expect(flags.slice(1)).toEqual([{ glob: true }, { glob: true }, { glob: true }, {}, {}, {}, { glob: true }])
  })

  test("an index is not a wildcard", () => {
    expect(only("Write-Output $a[0]").flags.slice(1)).toEqual([{ parameter: true }])
  })

  test("text after stop-parsing is literal", () => {
    const command = only("cmd --% /c echo $a *.c %PATH%")
    // Everything after --% is one literal word. Only a %VAR% in it is expanded (by cmd).
    expect(command.words).toEqual(["cmd", "--%", "/c echo $a *.c %PATH%"])
    expect(command.flags).toEqual([{}, {}, { parameter: true }])
    expect(only("cmd --% /c echo $a *.c").flags).toEqual([{}, {}, {}])
  })
})

describe("ShellScan.inspect powershell features", () => {
  const features = (input: string) => scanned(input).features
  test("none by default", () => {
    expect(features("Get-Date")).toEqual({
      assignment: false,
      envAssignment: false,
      stopParsing: false,
      callOperator: false,
      aliasDefinition: false,
      functionDefinition: false,
    })
  })

  test("an assignment and an env assignment", () => {
    expect(features("$x = 1")).toMatchObject({ assignment: true, envAssignment: false })
    expect(features("$x += 1")).toMatchObject({ assignment: true, envAssignment: false })
    for (const input of ["$env:FOO = 'a'", "$env:PATH += ';x'", "${env:FOO} = 1", "[string]$env:FOO = 'a'"]) {
      expect(features(input)).toMatchObject({ assignment: true, envAssignment: true })
    }
    // A hashtable entry is data.
    expect(features("Write-Output @{ a = 1 }").assignment).toBe(false)
  })

  test("alias definitions", () => {
    for (const input of ["Set-Alias ls Remove-Item", "new-alias ls Remove-Item", "sal ls Remove-Item", "NAL ls x"])
      expect(features(input).aliasDefinition).toBe(true)
    expect(features("Get-Alias ls").aliasDefinition).toBe(false)
    expect(features("ForEach-Object { sal a b }").aliasDefinition).toBe(true)
  })

  test("function definitions", () => {
    expect(features("function f { Remove-Item x }").functionDefinition).toBe(true)
    expect(features("filter f { $_ }").functionDefinition).toBe(true)
    expect(features("if ($x) { Get-Date }").functionDefinition).toBe(false)
  })

  test("stop-parsing", () => {
    expect(features("cmd --% /c dir").stopParsing).toBe(true)
    expect(features("cmd /c dir").stopParsing).toBe(false)
    // An escaped spelling is the same token.
    expect(features("cmd `--% /c dir").stopParsing).toBe(true)
    expect(features("cmd '--%' /c dir").stopParsing).toBe(false)
  })

  test("a call operator is literal or dynamic", () => {
    expect(features("& Get-Date").callOperator).toBe("literal")
    expect(features("& 'Get-Date'").callOperator).toBe("literal")
    expect(features(". ./script.ps1").callOperator).toBe("literal")
    expect(features("& $cmd").callOperator).toBe("dynamic")
    expect(features("& (Get-Command x)").callOperator).toBe("dynamic")
    expect(features('& "$cmd"').callOperator).toBe("dynamic")
    expect(features("Get-Date; & $cmd").callOperator).toBe("dynamic")
    expect(features("& $cmd; & Get-Date").callOperator).toBe("dynamic")
    expect(features("ForEach-Object { & $cmd }").callOperator).toBe("dynamic")
  })
})

describe("ShellScan.inspect powershell opaque classes", () => {
  test.each([
    ["Get-Date –Force", "invalid-structure", "unsupported"],
    ["Get-Date\0", "invalid-structure", "unsupported"],
    ["Write-Output 'a", "unterminated-quote", "syntax"],
    ["Write-Output a`", "unterminated-escape", "syntax"],
    ["Write-Output (a", "invalid-structure", "syntax"],
    ["Write-Output )", "invalid-structure", "syntax"],
    ["Get-Date 7> out", "invalid-redirect", "syntax"],
    ["Get-Date >", "invalid-structure", "syntax"],
    ["& ''", "dynamic-command-name", "unsupported"],
  ])("%j", (input, reason, opaqueClass) => {
    expect(ShellScan.inspect(input, "powershell")).toEqual({ kind: "opaque", reason, class: opaqueClass } as never)
  })

  test("size and depth are limits", () => {
    expect(ShellScan.inspect("a".repeat(70 * 1024), "powershell")).toMatchObject({ kind: "opaque", class: "limit" })
    const deep = `${"(".repeat(40)}Get-Date${")".repeat(40)}`
    expect(ShellScan.inspect(deep, "powershell")).toMatchObject({ kind: "opaque", class: "limit" })
    const unbalanced = `${"(".repeat(40)}Get-Date`
    expect(ShellScan.inspect(unbalanced, "powershell")).toMatchObject({ kind: "opaque", class: "limit" })
  })

  test("scanPowerShell keeps reporting the reason", () => {
    expect(ShellScan.scanPowerShell("Get-Date 7> out")).toEqual({ kind: "opaque", reason: "invalid-redirect" })
  })
})

// Each row ran .NET code or defined a command in Windows PowerShell 5.1 with nothing reported before.
describe("ShellScan.inspect powershell .NET statements", () => {
  test.each<[string, ShellScan.Invocation]>([
    ["[IO.StreamWriter]'victim.txt'", { kind: "conversion", type: "IO.StreamWriter" }],
    ['[IO.FileStream]"victim.txt"', { kind: "conversion", type: "IO.FileStream" }],
    ["[IO.StreamWriter] 'victim.txt'", { kind: "conversion", type: "IO.StreamWriter" }],
    ["[IO.StreamWriter]$path", { kind: "conversion", type: "IO.StreamWriter" }],
    ["[IO.StreamWriter]($path)", { kind: "conversion", type: "IO.StreamWriter" }],
    ["$w = [IO.StreamWriter]'victim.txt'", { kind: "conversion", type: "IO.StreamWriter" }],
    ["[IO.StreamWriter]$w = 'victim.txt'", { kind: "conversion", type: "IO.StreamWriter" }],
    ["'victim.txt' -as [IO.StreamWriter]", { kind: "conversion", type: "IO.StreamWriter" }],
    ["$x = $p -AS [IO.FileInfo]", { kind: "conversion", type: "IO.FileInfo" }],
  ])("a conversion is an invocation: %s", (input, invocation) => {
    expect(scanned(input).statements.flatMap((item) => item.invocations)).toContainEqual(invocation)
  })

  test.each(["[IO.File]", "$a[0]", "[int].Name", "$h[$k]", "Write-Output 5"])("no conversion in %s", (input) => {
    const result = scanned(input)
    expect([...result.commands, ...result.statements].flatMap((item) => item.invocations)).toEqual([])
  })

  test.each<[string, ShellScan.Invocation]>([
    ["(Get-Item a).IsReadOnly=$true", { kind: "setter", member: "IsReadOnly" }],
    ["$f.IsReadOnly = $true", { kind: "setter", member: "IsReadOnly" }],
    ["$f.Length += 1", { kind: "setter", member: "Length" }],
    ["$w.AutoFlush = $true", { kind: "setter", member: "AutoFlush" }],
    ["$f.$name = 1", { kind: "setter", member: "", dynamic: true }],
    ["$f.'Name' = 1", { kind: "setter", member: "", dynamic: true }],
    ["[Environment]::CurrentDirectory = 'x'", { kind: "setter", type: "Environment", member: "CurrentDirectory" }],
    ["$t::Prop = 1", { kind: "setter", type: "$t", member: "Prop", dynamic: true }],
    ["$x = Get-Item a; $x.Attributes = 'Hidden'", { kind: "setter", member: "Attributes" }],
  ])("a member assignment is a setter: %s", (input, invocation) => {
    const result = scanned(input)
    expect([...result.commands, ...result.statements].flatMap((item) => item.invocations)).toContainEqual(invocation)
  })

  test("a member name before = outside an assignment is text", () => {
    expect(only("Write-Output a.b=c").invocations).toEqual([])
    expect(statement("$x -eq $y.Name").invocations).toEqual([])
    expect(scanned("$x = $y.Name").statements.flatMap((item) => item.invocations)).toEqual([])
  })

  // Member access goes on over a line break after . or :: in an expression, so the next line is not a command.
  test.each<[string, ShellScan.Invocation[] | undefined]>([
    ["$f.\nDelete()", [{ kind: "instance", member: "Delete" }]],
    ["$f.\r\nDelete()", [{ kind: "instance", member: "Delete" }]],
    ["$f. \n  Delete()", [{ kind: "instance", member: "Delete" }]],
    ["[IO.File]::\nDelete('x')", [{ kind: "static", type: "IO.File", member: "Delete" }]],
    ["[IO.File]::\r\nDelete('x')", [{ kind: "static", type: "IO.File", member: "Delete" }]],
    ["[IO.File]::\f\nDelete('x')", [{ kind: "static", type: "IO.File", member: "Delete" }]],
    ["$t::\nDelete('x')", [{ kind: "static", type: "$t", member: "Delete", dynamic: true }]],
    ["(Get-Item a).\nDelete()", [{ kind: "instance", member: "Delete" }]],
    ["$w = [IO.StreamWriter]'victim-chain.txt'; $w.AutoFlush = $true; $w.\nWrite('payload')", undefined],
  ])("a line break after . or :: continues the statement: %j", (input, invocations) => {
    const result = scanned(input)
    if (!invocations) {
      expect(result.commands.map((command) => command.words[0])).not.toContain("Write")
      expect(result.statements.flatMap((item) => item.invocations)).toEqual([
        { kind: "conversion", type: "IO.StreamWriter" },
        { kind: "setter", member: "AutoFlush" },
        { kind: "instance", member: "Write" },
      ])
      return
    }
    expect(result.commands.map((command) => command.words[0])).not.toContain("Delete")
    expect([...result.commands, ...result.statements].flatMap((item) => item.invocations)).toEqual(invocations)
  })

  test("a line break after a number, a path or any command argument (variable, quote, parenthesis) still ends the statement", () => {
    for (const input of ["$x = 1.\nRemove-Item a", "cd .\nRemove-Item a", "cd ..\nRemove-Item a", "Write-Output $f.\nRemove-Item a", 'Write-Output "s".\nRemove-Item a', "Write-Output 's'.\nRemove-Item a", "Get-Content (gi x).\nRemove-Item a", "Write-Output (1).\nRemove-Item a", "Write-Output (1)\nRemove-Item a", 'Write-Output "s"\nRemove-Item a']) {
      expect(scanned(input).commands.map((command) => command.words[0])).toContain("Remove-Item")
    }
  })

  // Windows PowerShell 5.1 also continues over blank lines, comments and a backtick-newline after a trailing . or ::.
  // The scanner does not follow that, so every such spelling is opaque instead of a guess.
  test.each([
    "$w.\n\nWrite('payload')",
    "$w.\r\n\r\nWrite('payload')",
    "$w.\n \t \nWrite('payload')",
    "$w. # c\nWrite('payload')",
    "$w.\n# c\nWrite('payload')",
    "$w.\n  <# c #>Write('payload')",
    "$w.<# c #>Write('payload')",
    "$w.`\nWrite('payload')",
    "$w.`\r\nWrite('payload')",
    "[IO.File]::\n\nDelete('x')",
    "[IO.File]:: # c\nDelete('x')",
    "(Get-Item a).\n\nDelete()",
  ])("a trailing . or :: followed by more than one line break or a comment is opaque: %j", (input) => {
    expect(ShellScan.inspect(input, "powershell")).toMatchObject({ kind: "opaque", class: "syntax" })
  })

  test("a one-line continuation and a one-line call still report the invocation", () => {
    for (const input of ["$w.\nWrite('x')", "$w.Write('x')", "$w. \n  Write('x')"])
      expect(scanned(input).statements.flatMap((item) => item.invocations)).toContainEqual({ kind: "instance", member: "Write" })
  })

  // A <# #> comment glued to an expression token is a block comment, not a line comment that hides the rest.
  test.each([
    "$x<# c #>; Remove-Item a",
    "$x = $y<# c #>; Remove-Item a",
    "$x.Length<# c #>; Remove-Item a",
    "${x}<# c #>; Remove-Item a",
    "$x[0]<# c #>; Remove-Item a",
    "$(1)<# c #>; Remove-Item a",
    "@(1)<# c #>; Remove-Item a",
    "1<# c #>; Remove-Item a",
    "$x+1<# c #>; Remove-Item a",
    "[int]<# c #>; Remove-Item a",
    "$x<# c\n#>; Remove-Item a",
    "$x <# c #>; Remove-Item a",
    '"s"<# c #>; Remove-Item a',
    "Write-Output a<#c#>; Remove-Item b",
  ])("a glued block comment hides nothing: %j", (input) => {
    expect(scanned(input).commands.map((command) => command.words[0])).toContain("Remove-Item")
  })

  // Round 3. Windows PowerShell 5.1 (ParseInput) continues member access over every blank, not only space and tab,
  // and over a backtick-newline on the continued line.
  test.each([
    "$w.\n\t`\nWrite('payload')",
    "$w.\n`\r\nWrite('payload')",
  ])("member access over a blank, then a break, then a comment or backtick is opaque: %j", (input) => {
    expect(ShellScan.inspect(input, "powershell")).toMatchObject({ kind: "opaque", class: "syntax" })
  })

  test.each([
    "$w.\f\nWrite('x')",
    "$w.\v\nWrite('x')",
    "$w.\u00a0\nWrite('x')",
    "$w.\u1680\nWrite('x')",
    "$w.\u2000\nWrite('x')",
    "$w.\u2003\nWrite('x')",
    "$w.\u202f\nWrite('x')",
    "$w.\u205f\nWrite('x')",
    "$w.\u3000\nWrite('x')",
    "$w.\n\fWrite('x')",
    "$w.\u00a0Write('x')",
    "$w.\n\u00a0Write('x')",
  ])(
    "a continuation over blanks and one break reports the invocation: %j",
    (input) => {
      expect(scanned(input).statements.flatMap((item) => item.invocations)).toContainEqual({ kind: "instance", member: "Write" })
    },
  )

  // A glued . or :: in a command argument or a redirect target continues over a comment or a backtick-newline.
  test.each([
    "Write-Output $x.<#c#>Delete()",
    "Write-Output $x.`\nDelete()",
    "Write-Output $x.`\r\nDelete()",
    "Write-Output $x::`\nDelete()",
    "Write-Output ($x).`\nDelete()",
    'Write-Output "s".`\nDelete()',
    "Write-Output $x.y.`\nDelete()",
    "Write-Output -a:$x.`\nDelete()",
    "Get-Date > $x.`\nDelete()",
    "Write-Output $w.#c\nWrite(1)",
    "Write-Output $w.<# c #>$x > f",
  ])("a glued accessor before a comment or backtick in an argument is opaque: %j", (input) => {
    expect(ShellScan.inspect(input, "powershell")).toMatchObject({ kind: "opaque", class: "syntax" })
  })

  test.each(["Get-ChildItem . `\n-Recurse", "Get-ChildItem .`\n-Recurse", "Copy-Item $a `\n-Destination $b"])(
    "a backtick continuation that is not glued to a member stays scanned: %j",
    (input) => {
      expect(scanned(input).commands).toHaveLength(1)
    },
  )

  // 5.1 ends an expression-led argument word at a glued # or <# and starts a comment that hides what follows.
  test.each([
    "Write-Output $x.Length<# c #>; Remove-Item a",
    "Write-Output $x[0]<# c #>; Remove-Item a",
    "Write-Output $x::y<# c #>; Remove-Item a",
    "Write-Output $x.y.z<# c #>; Remove-Item a",
    "Write-Output ${x}.y<# c #>; Remove-Item a",
    "Write-Output $(1)<# c #>; Remove-Item a",
    "Write-Output @(1)<# c #>; Remove-Item a",
    "Write-Output @{a=1}.a<# c #>; Remove-Item a",
    "Write-Output -x:$(1)<# c #>; Remove-Item a",
    "Write-Output $x.y<# c #>| Remove-Item",
    "Write-Output $x.Length<# c #> > f",
    "Get-Date > $(1)<# c #>; Remove-Item a",
    "Write-Output $x.y#c; Remove-Item a",
    "Write-Output $(1)#c; Remove-Item a",
    "Write-Output @(1)#c; Remove-Item a",
    "Write-Output $x.Length#'\nRemove-Item a\n#'",
    "Get-Date > $y.z#; Remove-Item a",
  ])("a comment glued to an expression-led argument is opaque: %j", (input) => {
    expect(ShellScan.inspect(input, "powershell")).toMatchObject({ kind: "opaque", class: "syntax" })
  })

  test.each([
    "Write-Output a<#c#>; Remove-Item a",
    "Write-Output a#c; Remove-Item a",
    "Write-Output https://example.com/#frag; Remove-Item a",
    "git commit -m fix#12; Remove-Item a",
    "Write-Output (1)<# #>; Remove-Item a",
    "Write-Output 'a' <# #>; Remove-Item a",
    "Write-Output $x.y() <# #>; Remove-Item a",
    "Write-Output $x #c\nRemove-Item a",
  ])("a generic word or a spaced comment keeps its meaning: %j", (input) => {
    expect(scanned(input).commands.map((command) => command.words[0])).toContain("Remove-Item")
  })

  // The target of a redirect after an expression statement is read as a command argument, so # and = are text.
  test.each([
    ["$x > f#; Remove-Item a", "f#"],
    ["$x >> f#; Remove-Item a", "f#"],
    ["$x 2> f#; Remove-Item a", "f#"],
    ["$x>f#; Remove-Item a", "f#"],
    ["1 > f#; Remove-Item a", "f#"],
    ["$(1) > f#; Remove-Item a", "f#"],
    ["$x = 1 > f#; Remove-Item a", "f#"],
    ["$x > f<#; Remove-Item a #>", "f<#"],
    ["$x > f<#c#>", "f<#c#>"],
    ["$x > f=1", "f=1"],
    ["$x > f>g", "f>g"],
    ["$x > f>g", "f>g"],
    ["Get-Date > f#; Remove-Item a", "f#"],
  ])("a redirect target after an expression is a command argument: %j", (input, target) => {
    const result = scanned(input)
    expect([...result.statements, ...result.commands].flatMap((item) => item.redirects.map((redirect) => redirect.target))).toEqual([target])
    if (input.includes("Remove-Item")) expect(result.commands.map((command) => command.words[0])).toContain("Remove-Item")
  })

  test("a $-led argument ends at > in the scanner, which over-reports a write 5.1 does not make", () => {
    const result = scanned("Write-Output $x>f")
    expect(result.commands.flatMap((command) => command.redirects.map((redirect) => redirect.target))).toEqual(["f"])
  })

  test("a glued block comment before > leaves the redirect", () => {
    expect(scanned("$x<#c#>>f").statements.flatMap((item) => item.redirects.map((redirect) => redirect.target))).toEqual(["f"])
  })
})

describe("ShellScan.inspect powershell command definitions", () => {
  const features = (input: string) => scanned(input).features
  test.each([
    "${alias:Get-Content} = 'Remove-Item'; Get-Content victim.txt",
    "$alias:gc = 'Remove-Item'",
    "${ALIAS:gc}='Remove-Item'",
    "[string]$alias:gc = 'Remove-Item'",
    "Microsoft.PowerShell.Utility\\Set-Alias Get-Content Remove-Item; Get-Content victim.txt",
    "microsoft.powershell.utility\\sal gc ri",
    "Set-Item alias:gc Remove-Item",
    "Set-Item -Path alias:gc -Value Remove-Item",
    "New-Item -Path alias:gc -Value Remove-Item",
  ])("an alias definition: %s", (input) => {
    expect(features(input).aliasDefinition).toBe(true)
  })

  test.each([
    "${function:Get-Content} = 'Remove-Item victim.txt'; Get-Content x",
    "$function:f = { Remove-Item x }",
    "${FUNCTION:f}='x'",
    "Set-Item function:f { Remove-Item x }",
    "New-Item -Path function:f -Value { Remove-Item x }",
    "Set-Content function:f 'Remove-Item x'",
  ])("a function definition: %s", (input) => {
    expect(features(input).functionDefinition).toBe(true)
  })

  test.each(["Get-Item alias:gc", "Get-Content function:f", "$x = $alias:gc", "$x = $function:f", "Get-Alias gc", "Write-Output alias:gc"])(
    "reading is not a definition: %s",
    (input) => {
      expect(features(input)).toMatchObject({ aliasDefinition: false, functionDefinition: false })
    },
  )
})

describe("ShellScan.inspect powershell types", () => {
  test("the inspect overloads accept a dialect chosen at run time", () => {
    const shell = (Math.random() > 2 ? "bash" : "powershell") as "bash" | "powershell"
    expect(ShellScan.inspect("Get-Date", shell).kind).toBe("scanned")
  })
})

describe("ShellScan.inspect powershell cost", () => {
  // Each input ran in quadratic or worse time in the first version. A child process lets the deadline fire.
  const hostile: Array<[string, string]> = [
    ["receivers", `"Write-Output " + "a".repeat(30000) + " ::".repeat(20)`],
    ["open type literals", `"Write-Output x" + "[a".repeat(30000)`],
    ["open brackets", `"[".repeat(60000)`],
    ["long receiver", `"a".repeat(60000) + " ::M()"`],
    ["many receivers", `"x::y ".repeat(12000)`],
    ["many members", `"$a.b ".repeat(12000)`],
    ["many dots", `"a.b.c.d.e.".repeat(6000)`],
    ["many casts", `"[int]1 ".repeat(8000)`],
    ["many setters", `"$a.b = 1;".repeat(7000)`],
    ["many env reads", `"$env:A ".repeat(12000)`],
    ["here-string env reads", `'@"\\n' + "$env:A ".repeat(9000) + '\\n"@'`],
    ["continued members", `"$a.\\n".repeat(15000)`],
    ["many generics", `"$a.b[".repeat(12000)`],
    ["long word with many hashes", `"Write-Output -a" + "a".repeat(32000) + "#".repeat(32000)`],
    ["many glued comments", `"Write-Output a<#c#>".repeat(8000)`],
  ]
  test.each(hostile)(
    "%s finish under a deadline",
    async (_name, expression) => {
      const source = new URL("../../src/shell/scan.ts", import.meta.url).href
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `const { ShellScan } = await import(${JSON.stringify(source)}); ShellScan.inspect(${expression}, "powershell")`,
        ],
        stdout: "ignore",
        stderr: "ignore",
        timeout: 8000,
      })
      expect(await child.exited).toBe(0)
    },
    15000,
  )

  test.each([
    ["receivers", (count: number) => `"Write-Output " + "a".repeat(${count}) + " ::".repeat(20)`],
    ["open type literals", (count: number) => `"Write-Output x" + "[a".repeat(${count})`],
    ["many receivers", (count: number) => `"x::y ".repeat(${count})`],
  ])("%s grow linearly", async (_name, build) => {
    const source = new URL("../../src/shell/scan.ts", import.meta.url).href
    const time = async (count: number) => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `const { ShellScan } = await import(${JSON.stringify(source)});
           const input = ${build(count)}; ShellScan.inspect(input, "powershell");
           const start = performance.now(); for (let run = 0; run < 10; run++) ShellScan.inspect(input, "powershell"); console.log(performance.now() - start)`,
        ],
        stdout: "pipe",
        stderr: "ignore",
        timeout: 8000,
      })
      const elapsed = Number(await new Response(child.stdout).text())
      // A child killed at its deadline prints nothing, which would read as zero and pass the ratio.
      expect(await child.exited).toBe(0)
      expect(Number.isFinite(elapsed) && elapsed > 0).toBe(true)
      return elapsed
    }
    const small = await time(5000)
    const large = await time(20000)
    // Four times the input: linear is about 4x, quadratic is about 16x.
    expect(large / small).toBeLessThan(10)
  }, 30000)
})
