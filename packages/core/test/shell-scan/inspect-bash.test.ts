import { describe, expect, test } from "bun:test"
import { ShellScan } from "../../src/shell/scan"

function scanned(input: string) {
  const result = ShellScan.inspect(input)
  if (result.kind !== "scanned") throw new Error(`opaque: ${result.reason} (${result.class})`)
  return result
}

function only(input: string) {
  const result = scanned(input)
  expect(result.commands).toHaveLength(1)
  return result.commands[0]
}

describe("ShellScan.inspect redirects", () => {
  // Every BASH_REDIRECTS operator, with the write flag the approval layer needs.
  const operators: Array<[string, string, string, boolean]> = [
    ["cat > out", ">", "out", true],
    ["cat >> out", ">>", "out", true],
    ["cat >| out", ">|", "out", true],
    ["cat &> out", "&>", "out", true],
    ["cat &>> out", "&>>", "out", true],
    ["cat <> out", "<>", "out", true],
    ["cat >&out", ">&", "out", true],
    ["cat < in", "<", "in", false],
    ["cat <&in", "<&", "in", false],
    ["cat <<< word", "<<<", "word", false],
  ]
  test.each(operators)("%s", (input, operator, target, write) => {
    expect(only(input).redirects).toEqual([{ operator, target, raw: target, write, dynamic: false, nullSink: false }])
  })

  test.each(["cat 2>&1", "cat >&2", "cat >&-", "cat <&0", "cat 2>&1-"])(
    "%s is a duplication without a target",
    (input) => {
      const redirect = only(input).redirects[0]
      expect(redirect.target).toBeUndefined()
      expect(redirect.write).toBe(false)
    },
  )

  test("a file descriptor prefix is recorded", () => {
    expect(only("cat 2> err").redirects[0]).toMatchObject({ operator: ">", fd: "2", target: "err", write: true })
  })

  test.each([
    ["/dev/null", true],
    ["/dev/stdout", true],
    ["/dev/stderr", true],
    ["/dev/fd/3", true],
    ["/dev/sda", false],
    ["/tmp/dev/null", false],
  ])("null sink %s", (target, nullSink) => {
    expect(only(`echo x > ${target}`).redirects[0].nullSink).toBe(nullSink)
  })

  test("targets are unquoted and a dynamic target is flagged", () => {
    expect(only(`echo x > "a b"`).redirects[0]).toMatchObject({ target: "a b", raw: '"a b"', dynamic: false })
    expect(only("echo x > $HOME/f").redirects[0].dynamic).toBe(true)
    expect(only("echo x > $(pwd)/f").redirects[0].dynamic).toBe(true)
    expect(only("echo x > *.log").redirects[0].dynamic).toBe(true)
    expect(only("echo x > '$HOME'").redirects[0].dynamic).toBe(false)
    // A dynamic path cannot be a proven null sink.
    expect(only("echo x > /dev/$name").redirects[0].nullSink).toBe(false)
  })

  test("redirects belong to their own command in a list and a pipeline", () => {
    const { commands } = scanned("pwd && cat > out file | tee log 2> /dev/null")
    expect(commands.map((command) => command.redirects.map((redirect) => redirect.target))).toEqual([
      [],
      ["out"],
      ["/dev/null"],
    ])
  })

  test("redirect-only statements", () => {
    const result = scanned("> f")
    expect(result.commands).toEqual([])
    expect(result.statements).toHaveLength(1)
    expect(result.statements[0].redirects[0]).toMatchObject({ operator: ">", target: "f", write: true })
  })

  test("a group with a redirect keeps its commands nested", () => {
    for (const input of ["{ a; } > f", "(a) > f"]) {
      const result = scanned(input)
      expect(result.commands).toEqual([])
      expect(result.statements[0].redirects[0].target).toBe("f")
      expect(result.statements[0].nested.map((node) => [node.words, node.origin])).toEqual([[["a"], "group"]])
    }
  })

  test("a missing target is opaque syntax", () => {
    expect(ShellScan.inspect("cat >")).toMatchObject({ kind: "opaque", reason: "invalid-redirect", class: "syntax" })
  })
})

describe("ShellScan.inspect words", () => {
  test("expansion kinds, quoted and unquoted", () => {
    const command = only(`echo $A "$B" \${C} $(d) \`e\` $((1+2)) "$(f)" <(g) >(h) '$(x)' '$Y' "\\$Z"`)
    expect(command.flags).toEqual([
      {},
      { parameter: true },
      { parameter: true },
      { parameter: true },
      { command: true },
      { command: true },
      { arithmetic: true },
      { command: true },
      { process: true },
      { process: true },
      {},
      {},
      {},
    ])
  })

  test("glob, extglob and brace expansion are unquoted only", () => {
    const flags = only(`ls *.c a?b [ab]x +(a|b) {a,b} {1..3} "*" '?' \\* "{a,b}" [ -f x`).flags
    expect(flags.slice(1)).toEqual([
      { glob: true },
      { glob: true },
      { glob: true },
      { glob: true },
      { brace: true },
      { brace: true },
      {},
      {},
      {},
      {},
      {},
      {},
      {},
    ])
  })

  test("positional and special parameters count", () => {
    expect(only(`echo $1 $@ $? "$#"`).flags.slice(1)).toEqual([
      { parameter: true },
      { parameter: true },
      { parameter: true },
      { parameter: true },
    ])
  })

  test("prefix assignments are kept apart from the command", () => {
    const command = only("PATH=x A+=y git status")
    expect(command.words).toEqual(["git", "status"])
    expect(command.assignments).toEqual([
      { name: "PATH", value: "x", raw: "PATH=x", append: false, flags: {} },
      { name: "A", value: "y", raw: "A+=y", append: true, flags: {} },
    ])
    expect(ShellScan.inspect("PATH=x git status")).toMatchObject({ features: { assignment: true } })
  })

  test("an argument that looks like an assignment is not one", () => {
    expect(only("echo A=1").assignments).toEqual([])
  })

  test("assignment-only statements are commandless", () => {
    const result = scanned("A=$(x) B=2")
    expect(result.statements[0].assignments.map((assignment) => assignment.name)).toEqual(["A", "B"])
    expect(result.statements[0].assignments[0].flags).toEqual({ command: true })
    // The substitution has no owning command, so it is a top-level entry.
    expect(result.commands.map((command) => [command.words, command.origin])).toEqual([[["x"], "substitution"]])
  })

  test("assignment values are not globs", () => {
    expect(only("A=* env").assignments[0].flags).toEqual({})
  })
})

describe("ShellScan.inspect nesting", () => {
  const owned: Array<[string, string]> = [
    ["echo $(a)", "$( )"],
    ["echo `a`", "backticks"],
    ["echo <(a)", "<( )"],
    ["tee >(a)", ">( )"],
    ["echo $((1 + $(a)))", "arithmetic"],
    ['echo "$(a)"', "double quotes"],
    ["echo ${x:-$(a)}", "parameter default"],
  ]
  test.each(owned)("%s nests under its owner (%s)", (input) => {
    const command = only(input)
    expect(command.nested.map((node) => [node.words, node.origin])).toEqual([[["a"], "substitution"]])
  })

  test("nested commands are not spliced into the top level", () => {
    const result = scanned("echo $(a $(b))")
    expect(result.commands.map((command) => command.words)).toEqual([["echo", "$(a $(b))"]])
    const inner = result.commands[0].nested[0]
    expect(inner.words[0]).toBe("a")
    expect(inner.nested.map((node) => node.words)).toEqual([["b"]])
  })

  test("expansions with no owning command become top-level entries", () => {
    for (const [input, name] of [
      ["A=$(a)", "assignment-only"],
      ["for x in $(a); do :; done", "for-values"],
      ["[[ -n $(a) ]]", "[[ ]]"],
      ["(( $(a) > 1 ))", "(( ))"],
      ["> $(a)", "redirect-only"],
    ]) {
      const found = scanned(input).commands.find((command) => command.words[0] === "a")
      expect(found?.origin, name).toBe("substitution")
    }
  })

  test("groups nest under a statement", () => {
    const result = scanned("(a; b) && { c; }")
    const nested = result.statements.flatMap((statement) => statement.nested)
    expect(nested.map((node) => [node.words[0], node.origin])).toEqual([
      ["a", "group"],
      ["b", "group"],
      ["c", "group"],
    ])
  })

  test("heredoc bodies nest under the command that owns them", () => {
    const command = only("cat <<EOF\nhello $(a)\nEOF")
    expect(command.heredocs).toEqual([{ delimiter: "EOF", quoted: false, tabs: false, body: "hello $(a)\n" }])
    expect(command.nested.map((node) => [node.words, node.origin])).toEqual([[["a"], "heredoc"]])
  })

  test("a quoted heredoc keeps its body and nests nothing", () => {
    const command = only("psql <<'SQL'\nselect $(a);\nSQL")
    expect(command.heredocs).toEqual([{ delimiter: "SQL", quoted: true, tabs: false, body: "select $(a);\n" }])
    expect(command.nested).toEqual([])
  })

  test("a heredoc on the later command of a list belongs to it", () => {
    const { commands } = scanned("echo x && cat <<-EOF\n\tbody\nEOF")
    expect(commands[0].heredocs).toEqual([])
    expect(commands[1].heredocs[0]).toMatchObject({ tabs: true, body: "\tbody\n" })
  })
})

describe("ShellScan.inspect features", () => {
  test("flags", () => {
    expect(scanned("a").features).toEqual({ assignment: false, functionDefinition: false, background: false })
    expect(scanned("a &").features.background).toBe(true)
    expect(scanned("a && b").features.background).toBe(false)
    expect(scanned("f() { a; }").features.functionDefinition).toBe(true)
    expect(scanned("echo $(A=1 b)").features.assignment).toBe(true)
    expect(scanned("echo $(b &)").features.background).toBe(true)
  })
})

describe("ShellScan.inspect opaque classes", () => {
  const cases: Array<[string, string, ShellScan.OpaqueClass]> = [
    ["unterminated quote", `echo "a`, "syntax"],
    ["unterminated single quote", `echo 'a`, "syntax"],
    ["trailing escape", "echo a\\", "syntax"],
    ["unterminated substitution", "echo $(a", "syntax"],
    ["stray parenthesis", "echo (a)", "syntax"],
    ["empty group", "( )", "syntax"],
    ["dangling operator", "a &&", "syntax"],
    ["empty command", "a && ; b", "syntax"],
    ["stray fi", "fi", "syntax"],
    ["open if", "if a; then b", "syntax"],
    ["redirect without target", "cat >", "syntax"],
    ["heredoc without delimiter", "cat <<", "syntax"],
    ["non-ascii whitespace", "echo\u000ca", "unsupported"],
    ["heredoc without terminator", "cat <<EOF\nbody", "unsupported"],
    ["empty command name", `"" a`, "unsupported"],
    ["input size", "a ".repeat(40_000), "limit"],
    ["substitution depth", "echo " + "$(".repeat(40) + "a" + ")".repeat(40), "limit"],
    ["group depth", "(".repeat(40) + "a" + ")".repeat(40), "limit"],
    ["structure depth", "if a; then ".repeat(40) + "b; fi".repeat(40), "limit"],
  ]
  test.each(cases)("%s", (_name, input, expected) => {
    const result = ShellScan.inspect(input)
    expect(result.kind).toBe("opaque")
    if (result.kind === "opaque") expect(result.class).toBe(expected)
  })

  test("scan keeps reporting the reason alone", () => {
    expect(ShellScan.scan(`echo "a`)).toEqual({ kind: "opaque", reason: "unterminated-quote" })
  })
})
