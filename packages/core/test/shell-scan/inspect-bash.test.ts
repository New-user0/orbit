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

  test.each(["<<EOF\n$(z)\nEOF", "A=1 <<EOF\n$(z)\nEOF", "{ cat; } <<EOF\n$(z)\nEOF"])(
    "a heredoc on a commandless statement puts its substitutions at the top level: %p",
    (input) => {
      const found = scanned(input).commands.find((command) => command.words[0] === "z")
      expect(found?.origin).toBe("heredoc")
    },
  )

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
    ["trailing escape", "echo a\\", "unsupported"],
    ["delimiter depth", "cat <(( " + "( ".repeat(40) + "a" + " )".repeat(40) + " ))", "limit"],
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

// Class matrix for word expansion: positions (prefix assignment, declaration argument, plain argument, redirect target,
// array value) x expansions (glob, brace, tilde, nested command substitution).
describe("ShellScan.inspect expansion positions", () => {
  const argument: Array<[string, ShellScan.WordFlags]> = [
    ["echo A=*", { glob: true }],
    ["echo A={a,b}", { brace: true }],
    ['echo {a,"b c"}', { brace: true }],
    ["echo {a,{b}}", { brace: true }],
    ["echo {a}", {}],
    ["echo ~/f", { tilde: true }],
    ['echo "~/f"', {}],
    ["echo \\~/f", {}],
    ["echo A=~/x", { tilde: true }],
    ["echo ${x:-$(a)}", { parameter: true, command: true }],
    ["echo $((1+$(b)))", { arithmetic: true, command: true }],
    ["echo @(a|$(d))", { glob: true, command: true }],
    ['echo "${x:-$(a)}"', { parameter: true, command: true }],
    ['echo "${y:-`c`}"', { parameter: true, command: true }],
    ['echo "$((1+$(b)))"', { arithmetic: true, command: true }],
    ['echo "${a[$(x)]}"', { parameter: true, command: true }],
    ["echo {a, b}", {}],
    ["echo []a]", { glob: true }],
    ["echo [[]", { glob: true }],
    ["echo []]", { glob: true }],
    ['echo a[" "]b', { glob: true }],
    ["echo [a b]", {}],
    ["echo []", {}],
    ["echo [!]a]", { glob: true }],
    ['echo "[a]"', {}],
    ["echo \\[a\\]", {}],
    ['echo [a"]"', {}],
    ["echo \\$*", { glob: true }],
    ["echo \\$?", { glob: true }],
    ["echo \\$[ab]", { glob: true }],
    ["echo $*", { parameter: true }],
    ["echo $?", { parameter: true }],
    ["echo $#", { parameter: true }],
    ["echo $$*", { parameter: true, glob: true }],
    ["echo $$?", { parameter: true, glob: true }],
    ["echo $$'' *", { glob: true }],
    ["echo $${x} *", { glob: true }],
    ["echo a[0]=x", { arithmetic: true, glob: true }],
    ["export a[0]=x", { arithmetic: true }],
    ["echo $'\\x{2e}'", { undecoded: true }],
    ["echo $'a\\0b'", { undecoded: true }],
    ["echo $'\\x00'", { undecoded: true }],
    ["echo $'\\c@'", { undecoded: true }],
    ["echo $'\\c?'", { undecoded: true }],
    ["echo $'\\x2e'", {}],
    ["echo $'\\c\\\\'", {}],
    ["echo $'\\u{2e}'", {}],
    ["unset A=*", { glob: true }],
    ["export B={a,b}", { brace: true }],
    ["declare D={x,y}", { brace: true }],
    ["export E={1..3}", { brace: true }],
  ]
  test.each(argument)("argument %s", (input, expected) => {
    // One word per cell: the flags of the last word, so one word's flags cannot hide another's.
    expect(only(input).flags.at(-1)).toEqual(expected)
  })

  test("a prefix assignment and a declaration argument are exempt from glob and brace, not from tilde", () => {
    expect(only("A=* B={a,b} env").assignments.map((assignment) => assignment.flags)).toEqual([{}, {}])
    expect(only("A=~/x:~/y env").assignments[0].flags).toEqual({ tilde: true })
    expect(only("export A=* B=[ab]").flags.slice(1)).toEqual([{}, {}])
    expect(only("export B={a,b}").flags.slice(1)).toEqual([{ brace: true }])
    expect(only("declare -x A=*").flags.slice(1)).toEqual([{}, {}])
  })

  test.each([
    ["a[$(x)]=1", { arithmetic: true, command: true }],
    ["a=($(x))", { command: true }],
    ["a=(*)", { glob: true }],
    ["a=({b,c})", { brace: true }],
    ["a=(x $y)", { parameter: true }],
    ["a=(~/x)", { tilde: true }],
    ["a=([ab] x)", { glob: true }],
    ["a=([a b])", {}],
    ["a=('*' \"?\" {b})", {}],
    ["a=($(a=($(x))))", { command: true }],
    ["a=(\\* \\?)", {}],
    ["a=(!(x))", { glob: true }],
    ["a=(@(a|b))", { glob: true }],
    ["a=(+(a))", { glob: true }],
    ["a=(<(true))", { command: true, process: true }],
    ["a=([1]=~)", { glob: true, tilde: true }],
    ["a=([1]=x:~/y)", { glob: true, tilde: true }],
    ["a=(x:~/y)", {}],
    ["a=(x=~/y)", {}],
  ] as Array<[string, ShellScan.WordFlags]>)("assignment %s", (input, expected) => {
    expect(scanned(input).statements[0].assignments[0].flags).toEqual(expected)
  })

  test.each([
    ["echo x > ~/.bashrc", true],
    ["echo x > ~user/f", true],
    ['echo x > "~/f"', false],
    ["echo x > \\~/f", false],
    ["echo x > a~/f", false],
    ["echo x > A=*", true],
    ["echo x > B=~/f", true],
    ["echo x > A=x:~/f", true],
    ["echo x >> C=~", true],
    ["echo x > .[]m]cp.json", true],
    ["echo x > []p]re-commit", true],
    ["echo x $$'' > */.git/config", true],
    ["echo x $${x} > */.git/config", true],
    ["echo x > */.git/config", true],
    ["echo x > $'\\x{2e}mcp.json'", true],
    ["echo x > $'\\x{2E}git'", true],
    ["echo x > $'.bashrc\\0'", true],
    ["echo x > $'.mcp.json\\0.txt'", true],
    ["echo x > $'.mcp.json\\x00.txt'", true],
    ["echo x > $'a\\0b'c", true],
    ["echo x > $'\\c@'", true],
    ["echo x > $'\\c?'", true],
    ["echo x > $'\\x2emcp'", false],
    ["echo x > $'\\c\\\\'", false],
    ["echo x > [a b]", false],
    ["echo x > f", false],
  ])("redirect target %s dynamic=%p", (input, dynamic) => {
    expect(only(input).redirects[0].dynamic).toBe(dynamic)
  })
})

describe("ShellScan.inspect origin and background", () => {
  const flat = (nodes: ShellScan.Detail[]): ShellScan.Detail[] => nodes.flatMap((node) => [node, ...flat(node.nested)])
  test.each([
    ["( A=$(x) )", ["group", "substitution"]],
    ["{ [[ $(a) ]]; }", ["substitution"]],
    ["$(A=$(x))", ["substitution"]],
  ])("nested origins in %s", (input, origins) => {
    const result = scanned(input)
    const found = new Set(flat([...result.commands, ...result.statements]).map((node) => node.origin))
    expect([...found].filter(Boolean).map(String).sort()).toEqual([...origins].sort())
  })

  test("a coproc runs in the background", () => {
    expect(scanned("coproc a").features.background).toBe(true)
    expect(scanned("coproc NAME { a; }").features.background).toBe(true)
    expect(scanned("echo coproc").features.background).toBe(false)
  })
})

describe("ShellScan.inspect cost", () => {
  // Each input ran in cubic or quadratic time in the first version. A child process lets the deadline fire.
  const hostile: Array<[string, string]> = [
    ["brace commas", `"echo x" + "{,".repeat(4096)`],
    ["open braces", `"{".repeat(60000)`],
    // Prefixed so the [[ test-expression check does not refuse the input before any bracket is matched.
    ["open brackets", `"echo " + "[".repeat(60000)`],
    ["open brackets in an array", `"a=(" + "[".repeat(60000) + ")"`],
    ["brace ranges", `"echo " + "{a..".repeat(8000)`],
    ["array values", `"a=(" + "{,".repeat(8000) + ")"`],
    ["array chain", `"a=($(".repeat(15) + "x" + "))".repeat(15)`],
    ["array chain on lines", `Array.from({ length: 8 }, () => "a=($(".repeat(15) + "x" + "))".repeat(15)).join("\\n")`],
    [
      "array tree",
      `(() => { let x = "a"; for (let i = 0; i < 10; i++) x = "a=($(" + x + ") $(" + x + "))"; return x })()`,
    ],
  ]
  test.each(hostile)(
    "%s finish under a deadline",
    async (_name, expression) => {
      const source = new URL("../../src/shell/scan.ts", import.meta.url).href
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `const { ShellScan } = await import(${JSON.stringify(source)}); ShellScan.inspect(${expression})`,
        ],
        stdout: "ignore",
        stderr: "ignore",
        timeout: 8000,
      })
      expect(await child.exited).toBe(0)
    },
    15000,
  )

  test("a nested array tree still scans, once per substitution", () => {
    const tree = Array.from({ length: 10 }).reduce<string>((x) => "a=($(" + x + ") $(" + x + "))", "a")
    const result = ShellScan.scan(tree)
    expect(result.kind).toBe("scanned")
    if (result.kind === "scanned") expect(result.commands).toHaveLength(1024)
  })

  test("bracket checks grow linearly", async () => {
    const source = new URL("../../src/shell/scan.ts", import.meta.url).href
    const time = async (count: number) => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          `const { ShellScan } = await import(${JSON.stringify(source)});
           const input = "echo " + "[".repeat(${count}); ShellScan.inspect(input);
           const start = performance.now(); for (let run = 0; run < 20; run++) ShellScan.inspect(input); console.log(performance.now() - start)`,
        ],
        stdout: "pipe",
        stderr: "ignore",
        timeout: 8000,
      })
      return Number(await new Response(child.stdout).text())
    }
    const small = await time(15000)
    const large = await time(60000)
    // Linear growth gives a ratio near 4. Quadratic growth gives near 16.
    expect(large / Math.max(small, 1)).toBeLessThan(10)
  }, 20000)
})

// \c followed by a backslash: bash pairs \\ as ctrl-backslash and closes the string at the next quote. The first
// version of the decoder read \' as an escaped quote, kept the string open and hid the command after it. This is the
// one deliberate change to scan() in this PR.
describe("ShellScan $'...' with a control escape", () => {
  test.each([
    ["echo $'\\c\\\\'; touch pwned #'", ["echo", "touch"]],
    ["echo $'\\c\\\\'\ntouch pwned\necho '#'", ["echo", "touch", "echo"]],
  ])("%j closes where bash closes it", (input, names) => {
    for (const result of [ShellScan.scan(input), ShellScan.inspect(input)]) {
      expect(result.kind).toBe("scanned")
      if (result.kind === "scanned") expect(result.commands.map((command) => command.words[0])).toEqual(names)
    }
  })

  test("the control character is 0x1c", () => {
    expect(only("echo $'\\c\\\\'").words[1]).toBe("\x1c")
  })
})
