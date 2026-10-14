import { describe, expect, test } from "bun:test"
import { ShellScan } from "../../src/shell/scan"

function scanned(input: string) {
  const result = ShellScan.inspect(input)
  if (result.kind !== "scanned") throw new Error(`opaque: ${result.reason} (${result.class})`)
  return result
}

function names(input: string) {
  return [ShellScan.scan(input), ShellScan.inspect(input)].map((result) => {
    expect(result.kind).toBe("scanned")
    return result.kind === "scanned" ? result.commands.map((command) => command.words[0]) : []
  })
}

// Output bytes of bash 5.2.37 (GNU bash, x86_64-pc-linux-gnu, LC_ALL=C.UTF-8) for `printf %s $'<body>'`, taken with od.
// Each row is [text between $' and ', hex bytes]. The decoder must give the same bytes or mark the word undecoded.
const bash: Array<[string, string]> = [
  [String.raw`\101`, "41"],
  [String.raw`\456`, "2e"],
  [String.raw`\457`, "2f"],
  [String.raw`\400`, ""],
  [String.raw`\377`, "ff"],
  [String.raw`\200`, "80"],
  [String.raw`\777`, "ff"],
  [String.raw`\600`, "80"],
  [String.raw`\577`, "7f"],
  [String.raw`\500`, "40"],
  [String.raw`\1`, "01"],
  [String.raw`\12`, "0a"],
  [String.raw`\0`, ""],
  [String.raw`\00`, ""],
  [String.raw`\08`, ""],
  [String.raw`\18`, "0138"],
  [String.raw`\8`, "5c38"],
  [String.raw`\x41`, "41"],
  [String.raw`\x4`, "04"],
  [String.raw`\x4g`, "0467"],
  [String.raw`\xff`, "ff"],
  [String.raw`\x80`, "80"],
  [String.raw`\x7f`, "7f"],
  [String.raw`\xe9`, "e9"],
  [String.raw`\x00`, ""],
  [String.raw`\xg`, "5c7867"],
  [String.raw`\x`, "5c78"],
  [String.raw`\u41`, "41"],
  [String.raw`\u2e`, "2e"],
  [String.raw`\u0`, ""],
  [String.raw`\U41`, "41"],
  [String.raw`\U2e`, "2e"],
  [String.raw`\U0`, ""],
  [String.raw`\U110000`, "f4908080"],
  [String.raw`\U7fffffff`, "fdbfbfbfbfbf"],
  [String.raw`\Uffffffff`, ""],
  [String.raw`\ca`, "01"],
  [String.raw`\cA`, "01"],
  [String.raw`\c@`, ""],
  [String.raw`\c?`, "7f"],
  ["\\cé", "03a9"],
  ["\\c😀", "109f9880"],
  ["\\u00e9", "c3a9"],
  [String.raw`\ud800`, "eda080"],
  [String.raw`\U0001f600`, "f09f9880"],
  [String.raw`\c[`, "1b"],
  [String.raw`\c\\`, "1c"],
  [String.raw`\c\\x`, "1c78"],
  [String.raw`\c\/`, "1c2f"],
  [String.raw`\c\n`, "1c6e"],
  [String.raw`\c\x41`, "1c783431"],
  [String.raw`\c\'x`, "1c2778"],
  [String.raw`\c`, "5c63"],
  [String.raw`a\c`, "615c63"],
  [String.raw`\cb\cc`, "0203"],
  [String.raw`\a\e\E\f\n\r\t\v`, "071b1b0c0a0d090b"],
  [String.raw`\\`, "5c"],
  [String.raw`\'`, "27"],
  [String.raw`\"`, "22"],
  [String.raw`\?`, "3f"],
  [String.raw`\q`, "5c71"],
]

describe("ShellScan $'...' decoder against bash 5.2.37", () => {
  test.each(bash)("%s", (body, hex) => {
    const command = scanned(`echo $'${body}'`).commands[0]
    const flags = command.flags[1]
    // A word is either decoded to exactly bash's bytes or marked dynamic.
    if (!flags.undecoded) expect(Buffer.from(command.words[1], "utf8").toString("hex")).toBe(hex)
  })

  // Every escape whose bytes a JS string cannot hold, or that bash reads differently, must be marked.
  test.each([
    "\\400",
    "\\200",
    "\\377",
    "\\777",
    "\\600",
    "\\x80",
    "\\xff",
    "\\xe9",
    "\\U110000",
    "\\Uffffffff",
    "\\x{2e}",
    "\\u00e9",
    "\\ud800",
    "\\U0001f600",
    "\\cé",
    "\\c😀",
  ])("%s is undecoded in a word, an assignment value and an array value", (body) => {
    expect(scanned(`echo $'${body}'`).commands[0].flags[1].undecoded).toBe(true)
    expect(scanned(`a=$'${body}' env`).commands[0].assignments[0].flags.undecoded).toBe(true)
    expect(scanned(`a=($'${body}')`).statements[0].assignments[0].flags.undecoded).toBe(true)
  })

  test.each(["\\400", "\\200", "\\777", "\\u00e9", "\\ud800", "\\U0001f600", "\\cé", "\\c😀"])("the redirect target %s is dynamic", (body) => {
    expect(scanned(`echo x > $'${body}mcp.json'`).commands[0].redirects[0].dynamic).toBe(true)
    expect(scanned(`echo x > $'..${body}pwned'`).commands[0].redirects[0].dynamic).toBe(true)
  })

  // Bash keeps one byte of an octal escape, so \456 is "." and \457 is "/": the target is static and must read so.
  test.each([
    ["echo x > $'\\456mcp.json'", ".mcp.json"],
    ["echo x > $'..\\457pwned'", "../pwned"],
  ])("the redirect target %j reads as %j", (input, target) => {
    const redirect = scanned(input).commands[0].redirects[0]
    expect(redirect.target).toBe(target)
    expect(redirect.dynamic).toBe(false)
  })

  test.each([
    ["echo x > $'\\c\\/'.bashrc", "\x1c/.bashrc"],
    ["echo x > $'\\c\\n'.bashrc", "\x1cn.bashrc"],
  ])("the redirect target %j reads as %j", (input, target) => {
    const redirect = scanned(input).commands[0].redirects[0]
    expect(redirect.target).toBe(target)
    expect(redirect.dynamic).toBe(false)
  })
})

describe("ShellScan $'\\c...' scan() words", () => {
  test.each([
    [String.raw`echo $'\c\/'`, "\x1c/"],
    [String.raw`echo $'\c\n'`, "\x1cn"],
    [String.raw`echo $'\c\x41'`, "\x1cx41"],
    [String.raw`echo $'\c\'x'`, "\x1c'x"],
    [String.raw`echo $'\c\\'`, "\x1c"],
    [String.raw`echo $'\c'`, "\\c"],
  ])("%j reads as %j in scan() and inspect()", (input, word) => {
    const result = ShellScan.scan(input)
    expect(result.kind).toBe("scanned")
    if (result.kind === "scanned") expect(result.commands[0].words[1]).toBe(word)
    expect(scanned(input).commands[0].words[1]).toBe(word)
  })
})

// Bash ends $'...' at the first quote no backslash escapes, so \c' closes the string and the next command is real.
describe("ShellScan $'\\c' closes at its quote", () => {
  test.each([
    ["echo $'\\c'; touch pwned #'", ["echo", "touch"]],
    ["echo $(echo $'\\c'); touch pwned #'", ["echo", "touch"]],
    ["echo $'\\c\\\\'; touch pwned #'", ["echo", "touch"]],
  ])("%j", (input, expected) => {
    for (const found of names(input)) {
      expect(found[0]).toBe("echo")
      expect(found.filter((name) => name === "touch")).toEqual(expected.filter((name) => name === "touch"))
    }
  })
})

// A heredoc delimiter that bash decodes differently ends the heredoc at another line, which hides the commands after
// it. scan() now refuses such a delimiter (it used to decode it as if bash agreed).
describe("ShellScan heredoc delimiter in $'...'", () => {
  test.each([
    // The terminator line is the one the decoder would match without the refusal, so a missing refusal runs touch.
    "cat <<$'E\\x{4f}F'\nbody\nE\\x{4f}F\ntouch pwned\n",
    "cat <<$'EOF\\400'\nbody\nEOF\0\ntouch pwned\n",
    "cat <<$'E\\xffF'\nbody\nEÿF\ntouch pwned\n",
    "cat <<$'E\\777F'\nbody\nEÿF\ntouch pwned\n",
    "cat <<$'E\\U110000F'\nbody\nEF\ntouch pwned\n",
    // Under LANG unset bash keeps \u and \U as text, in a UTF-8 locale it writes other bytes (\c is the same in every
    // locale); either way the line below
    // is the one the decoder would match, so cat <<$'\u00e9' must not hide touch.
    "cat <<$'\\u00e9'\nbody\né\ntouch pwned\n",
    "cat <<$'\\ud800'\nbody\n\ud800\ntouch pwned\n",
    "cat <<$'\\U0001f600'\nbody\n😀\ntouch pwned\n",
    "cat <<$'\\cé'\nbody\n\t\ntouch pwned\n",
  ])("%j is refused", (input) => {
    expect(ShellScan.scan(input).kind).not.toBe("scanned")
    expect(ShellScan.inspect(input).kind).not.toBe("scanned")
  })

  test("a delimiter that decodes the way bash does still works", () => {
    for (const input of ["cat <<$'E\\x4fF'\nbody\nEOF\ntouch pwned\n", "cat <<$'\\456EOF'\nbody\n.EOF\ntouch pwned\n"])
      for (const found of names(input)) expect(found).toEqual(["cat", "touch"])
  })
})

describe("ShellScan array values with $'...'", () => {
  test.each([
    ["a=($'\\'' *)", { glob: true }],
    ["a=($'*' x)", {}],
    ["a=([1]=$'\\x{2e}')", { glob: true, undecoded: true }],
    ["a=($'\\x{2e}')", { undecoded: true }],
    ["a=($'\\x2e' *)", { glob: true }],
    ["a=($'a b' ~/x)", { tilde: true }],
  ] as Array<[string, ShellScan.WordFlags]>)("%s", (input, expected) => {
    expect(scanned(input).statements[0].assignments[0].flags).toEqual(expected)
  })

  test.each([
    ['declare -A h=(["a b"]=~/z)', { glob: true, tilde: true }],
    ['declare -A h=(["a b"]=x:~/z)', { glob: true, tilde: true }],
  ] as Array<[string, ShellScan.WordFlags]>)("a quoted subscript with a space: %s", (input, expected) => {
    expect(scanned(input).commands[0].flags.at(-1)).toEqual(expected)
  })

  test("a plain assignment with a quoted subscript and a space", () => {
    expect(scanned("a=(['a b']=~/z)").statements[0].assignments[0].flags).toEqual({ glob: true, tilde: true })
  })
})
