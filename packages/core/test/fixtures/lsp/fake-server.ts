// A minimal language server for tests: it reports an error on every line that contains "ERROR".
// After a save it also reports what a deeper on-save check would find, and says what the save carried.
// `--plain-save` makes it advertise saves without text.
import { appendFileSync, writeFileSync } from "fs"
import { createMessageConnection, ResponseError, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
const texts = new Map<string, string>()
const diagnostic = (line: number, character: number, end: number, message: string, extra: object = {}) => ({
  range: { start: { line, character }, end: { line, character: end } },
  severity: 1,
  message,
  ...extra,
})
// Markers a test puts in a line: ERROR, WARN and HINT report that severity, NOSEV reports no severity at all, and LATE
// is reported only by a second publication `--late-ms=<n>` (default 4 s) after the text arrives, outside the 3 s an edit
// waits. `CODE=<x>` on the line adds that code and the source "fake".
const flagValue = (name: string) =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const MARKERS = [
  ["ERROR", { severity: 1 }],
  ["WARN", { severity: 2 }],
  ["HINT", { severity: 4 }],
  ["NOSEV", { severity: undefined }],
] as const
// The files whose late problems were already published, so that later publications keep them.
const lateReady = new Set<string>()
const found = (text: string, uri = "") =>
  text.split("\n").flatMap((line, index) => {
    const code = /CODE=(\S+)/.exec(line)?.[1]
    const extra = code === undefined ? {} : { code, source: "fake" }
    const marked = MARKERS.filter(([name]) => line.includes(name)).map(([name, severity]) =>
      diagnostic(index, line.indexOf(name), line.length, `found ${name}`, { ...severity, ...extra }),
    )
    const late =
      line.includes("LATE") && lateReady.has(uri)
        ? [diagnostic(index, line.indexOf("LATE"), line.length, "found LATE", extra)]
        : []
    return [...marked, ...late]
  })
// `--encoded-uris` writes the address the way several servers do: the drive in lower case with the colon encoded on
// Windows, and every dash percent-encoded, which is a second spelling of the same file on any platform.
const spelled = (uri: string) =>
  process.argv.includes("--encoded-uris")
    ? uri
        .replace(/^file:\/\/\/([A-Za-z]):/, (_, drive: string) => `file:///${drive.toLowerCase()}%3A`)
        .replaceAll("-", "%2D")
    : uri
const publish = (uri: string, diagnostics: ReturnType<typeof found>) =>
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri: spelled(uri),
    // `--malformed` adds one entry that has no range to every publication.
    diagnostics: process.argv.includes("--malformed") ? [...diagnostics, { severity: 1, message: "no range" }] : diagnostics,
  })
const remember = (uri: string, text: string) => {
  texts.set(uri, text)
  lateReady.delete(uri)
  if (text.includes("LATE"))
    setTimeout(
      () => {
        if (texts.get(uri) !== text) return
        lateReady.add(uri)
        void publish(uri, found(text, uri))
      },
      Number(flagValue("late-ms") ?? 4000),
    ).unref()
  return publish(uri, found(text, uri))
}
// The project root as the client sent it; positions in answers are built from it.
let rootUri = ""
connection.onRequest("initialize", (params: { rootUri: string }) => {
  rootUri = params.rootUri.replace(/\/$/, "")
  const recorded = process.argv.find((argument) => argument.startsWith("--record-init="))?.slice("--record-init=".length)
  if (recorded) writeFileSync(recorded, JSON.stringify(params))
  return {
  capabilities: {
    textDocumentSync: process.argv.includes("--plain-save")
      ? { openClose: true, change: 1, save: {} }
      : process.argv.includes("--save-true")
        ? { openClose: true, change: 1, save: true }
        : process.argv.includes("--sync-kind")
          ? 1
          : { openClose: true, change: 1, save: { includeText: true } },
    hoverProvider: true,
  },
  }
})
connection.onRequest("shutdown", () => null)
connection.onNotification("exit", () => process.exit(0))
// `--marker=<file>` appends a line to the file for every document the server is told to open, so a test can tell that
// a server read a file at all.
const changes = process.argv.find((argument) => argument.startsWith("--changes="))?.slice("--changes=".length)
const marker = process.argv.find((argument) => argument.startsWith("--marker="))?.slice("--marker=".length)
connection.onNotification("textDocument/didOpen", (params: { textDocument: { uri: string; text: string } }) => {
  if (marker) appendFileSync(marker, `${params.textDocument.uri}\n`)
  return remember(params.textDocument.uri, params.textDocument.text)
})
connection.onNotification(
  "textDocument/didChange",
  (params: { textDocument: { uri: string }; contentChanges: { text: string }[] }) => {
    // `--changes=<file>` appends a line for every document change, so a test can count how often a text was sent.
    if (changes) appendFileSync(changes, `${params.textDocument.uri}\n`)
    return remember(params.textDocument.uri, params.contentChanges.at(-1)?.text ?? "")
  },
)
connection.onNotification("textDocument/didSave", (params: { textDocument: { uri: string }; text?: string }) => {
  const uri = params.textDocument.uri
  const known = texts.get(uri)
  if (known === undefined) return publish(uri, [diagnostic(0, 0, 1, "saved before open")])
  const extra = !known.includes("ERROR")
    ? []
    : [
        diagnostic(
          0,
          0,
          1,
          typeof params.text !== "string"
            ? "checked on save (no text)"
            : params.text === known
              ? "checked on save (with text)"
              : "checked on save (stale text)",
        ),
      ]
  return publish(uri, [...found(known, uri), ...extra])
})
// Flags for the requests beyond diagnostics:
// `--content-modified=<n>` answers the first n queries with error -32801, `--fail=<code>` answers every query with that
// error, `--record-init=<file>` writes the initialize params, `--log=<file>` appends each query the server gets and
// `--null-calls` makes the call lists answer null.
const flag = (name: string) => process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
const logFile = flag("log")
let contentModified = Number(flag("content-modified") ?? 0)
const failCode = flag("fail")
// `--encoded-uris` writes the drive the way several servers do on Windows: lower case, with the colon encoded.
// `--src=<folder>` moves every answer that would be under `src/` into that folder, such as an ignored one.
const srcFolder = flag("src") ?? "src"
const at = (name: string) => {
  const file = name.startsWith("src/") ? `${srcFolder}/${name.slice(4)}` : name
  return `${
    process.argv.includes("--encoded-uris")
      ? rootUri.replace(/^file:\/\/\/([A-Za-z]):/, (_, drive: string) => `file:///${drive.toLowerCase()}%3A`)
      : rootUri
  }/${file}`
}
const lineAt = (uri: string, number: number) => texts.get(uri)?.split("\n")[number] ?? ""
const range = (startLine: number, character = 0) => ({
  start: { line: startLine, character },
  end: { line: startLine, character: character + 3 },
})
type Here = { textDocument: { uri: string }; position: { line: number } }
const query = <P = Here>(method: string, handler: (params: P) => unknown) =>
  connection.onRequest(method, (params: P) => {
    if (logFile) appendFileSync(logFile, JSON.stringify({ method, params }) + "\n")
    if (failCode) throw new ResponseError(Number(failCode), "forced failure")
    if (contentModified > 0) {
      contentModified -= 1
      throw new ResponseError(-32801, "content modified")
    }
    return handler(params)
  })
const here = (params: Here) =>
  lineAt(params.textDocument.uri, params.position.line)

query("textDocument/hover", (params) =>
  here(params).includes("list")
    ? { contents: ["first part", { language: "ts", value: "second part" }], range: range(2, 4) }
    : { contents: { kind: "markdown", value: "a fake symbol" } },
)
query("textDocument/definition", (params) =>
  here(params).includes("multi")
    ? [
        { uri: at("src/one.fake"), range: range(0) },
        { targetUri: at("src/two.fake"), targetRange: range(9), targetSelectionRange: range(10, 2) },
      ]
    : { uri: at("src/one.fake"), range: range(4, 2) },
)
query("textDocument/references", (params) =>
  here(params).includes("single")
    ? [{ uri: at("src/b.fake"), range: range(2, 4) }]
    : here(params).includes("outside")
      ? [
          { uri: at("../one-up.fake"), range: range(0) },
          { uri: at("../../two-up.fake"), range: range(0) },
          // `--other-drive` adds a file on another Windows drive.
          ...(process.argv.includes("--other-drive") ? [{ uri: "file:///Z:/elsewhere/x.fake", range: range(0) }] : []),
        ]
      : [
        { uri: at("ignored/a.fake"), range: range(0) },
        { uri: at("src/b.fake"), range: range(2, 4) },
        { uri: at("src/b.fake"), range: range(5, 1) },
        { uri: at("src/c.fake"), range: range(1, 0) },
      ],
)
query("textDocument/implementation", (params) =>
  here(params).includes("impl")
    ? [
        { uri: at("src/impl-a.fake"), range: range(4, 2) },
        // A link with no selection range points at its whole target.
        { targetUri: at("src/impl-b.fake"), targetRange: range(9, 1) },
      ]
    : null,
)
query("textDocument/documentSymbol", () => [
  {
    name: "Outer",
    kind: 5,
    detail: "detail text",
    range: range(1),
    selectionRange: range(2),
    children: [{ name: "inner", kind: 6, range: range(3), selectionRange: range(3) }],
  },
])
query("workspace/symbol", () => [
  { name: "alpha", kind: 12, location: { uri: at("src/a.fake"), range: range(3) }, containerName: "Box" },
  { name: "beta", kind: 13, location: { uri: at("src/b.fake"), range: range(7) } },
  { name: "gamma", kind: 5, location: { uri: at("src/a.fake"), range: range(9) } },
  // A WorkspaceSymbol may carry only the URI.
  { name: "bare", kind: 12, location: { uri: at("src/bare.fake") } },
  { name: "nowhere", kind: 12 },
  { name: "two\nlines\r\n(x: number)", kind: 12, location: { uri: at("src/lines.fake"), range: range(1) } },
  { name: "jar", kind: 5, location: { uri: "jdt://contents/lib.jar/Thing.class", range: range(0) } },
  { name: "mystery", kind: 99, location: { uri: at("src/a.fake"), range: range(11) } },
  { name: "hidden", kind: 12, location: { uri: at("ignored/h.fake"), range: range(0) } },
])
query("textDocument/prepareCallHierarchy", (params) =>
  here(params).includes("fn")
    ? [
        {
          name: "first",
          kind: 12,
          uri: at("src/fn.fake"),
          range: range(5),
          selectionRange: range(5),
          detail: "(a: number)",
          data: { token: "first" },
        },
        { name: "second", kind: 6, uri: at("src/fn.fake"), range: range(20), selectionRange: range(20) },
      ]
    : [],
)
const calls = (side: "from" | "to") => (params: { item: { data?: { token?: string } } }) => {
  // Only the first prepared item, exactly as sent, is a valid argument.
  if (params.item.data?.token !== "first") throw new ResponseError(-32602, "unexpected item")
  if (process.argv.includes("--null-calls")) return null
  return [
    { [side]: { name: "one", kind: 12, uri: at("src/c1.fake"), range: range(7) }, fromRanges: [range(3, 1), range(4, 2)] },
    { [side]: { name: "two", kind: 6, uri: at("src/c2.fake"), range: range(8) }, fromRanges: [range(6, 0)] },
    { [side]: { name: "three", kind: 12, uri: at("src/c1.fake"), range: range(12) }, fromRanges: [range(9, 3)] },
    // No caller or callee: skipped.
    { fromRanges: [range(1)] },
  ]
}
query("callHierarchy/incomingCalls", calls("from"))
query("callHierarchy/outgoingCalls", calls("to"))
connection.listen()
