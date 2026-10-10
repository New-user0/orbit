// A minimal language server for tests: it reports an error on every line that contains "ERROR".
// After a save it also reports what a deeper on-save check would find, and says what the save carried.
// `--plain-save` makes it advertise saves without text.
import { appendFileSync } from "fs"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
const texts = new Map<string, string>()
const diagnostic = (line: number, character: number, end: number, message: string) => ({
  range: { start: { line, character }, end: { line, character: end } },
  severity: 1,
  message,
})
const found = (text: string) =>
  text
    .split("\n")
    .flatMap((line, index) =>
      line.includes("ERROR") ? [diagnostic(index, line.indexOf("ERROR"), line.length, "found ERROR")] : [],
    )
const publish = (uri: string, diagnostics: ReturnType<typeof found>) =>
  connection.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics })
const remember = (uri: string, text: string) => {
  texts.set(uri, text)
  return publish(uri, found(text))
}
connection.onRequest("initialize", () => ({
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
}))
connection.onRequest("shutdown", () => null)
connection.onNotification("exit", () => process.exit(0))
// `--marker=<file>` appends a line to the file for every document the server is told to open, so a test can tell that
// a server read a file at all.
const marker = process.argv.find((argument) => argument.startsWith("--marker="))?.slice("--marker=".length)
connection.onNotification("textDocument/didOpen", (params: { textDocument: { uri: string; text: string } }) => {
  if (marker) appendFileSync(marker, `${params.textDocument.uri}\n`)
  return remember(params.textDocument.uri, params.textDocument.text)
})
connection.onNotification(
  "textDocument/didChange",
  (params: { textDocument: { uri: string }; contentChanges: { text: string }[] }) =>
    remember(params.textDocument.uri, params.contentChanges.at(-1)?.text ?? ""),
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
  return publish(uri, [...found(known), ...extra])
})
connection.onRequest("textDocument/hover", () => ({ contents: { kind: "markdown", value: "a fake symbol" } }))
connection.listen()
