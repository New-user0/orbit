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
    expect(command.redirects[0]).toMatchObject({ operator: ">&", write: false, dynamic: false, nullSink: false })
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

  test.each([
    ["Write-Output a>f", "f"],
    ["Write-Output a>>f", "f"],
    ["Write-Output a> f", "f"],
    ['Write-Output a>"f g"', "f g"],
  ])("a > glued to a token still redirects: %s", (input, target) => {
    expect(only(input).redirects.map((redirect) => [redirect.target, redirect.write])).toEqual([[target, true]])
  })

  test("a > glued to a token cannot hide a computed target", () => {
    expect(only("Write-Output a>$p").redirects[0]).toMatchObject({ target: "$p", dynamic: true })
    expect(only("Write-Output a>(Join-Path a b)").redirects[0].dynamic).toBe(true)
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

  test("an expression with nothing to report is not a statement entry", () => {
    expect(scanned("$x.Length").statements).toEqual([])
    expect(scanned("'x'").statements).toEqual([])
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
    expect(scanned("[Environment]::CurrentDirectory").statements).toEqual([])
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
    expect(scanned("$x.Length").statements).toEqual([])
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
