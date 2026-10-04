// A minimal language server for tests: it reports an error on every line that contains "ERROR".
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
const publish = (uri: string, text: string) =>
  connection.sendNotification("textDocument/publishDiagnostics", {
    uri,
    diagnostics: text.split("\n").flatMap((line, index) =>
      line.includes("ERROR")
        ? [
            {
              range: {
                start: { line: index, character: line.indexOf("ERROR") },
                end: { line: index, character: line.length },
              },
              severity: 1,
              message: "found ERROR",
            },
          ]
        : [],
    ),
  })
connection.onRequest("initialize", () => ({ capabilities: { textDocumentSync: 1, hoverProvider: true } }))
connection.onRequest("shutdown", () => null)
connection.onNotification("exit", () => process.exit(0))
connection.onNotification("textDocument/didOpen", (params: { textDocument: { uri: string; text: string } }) =>
  publish(params.textDocument.uri, params.textDocument.text),
)
connection.onNotification(
  "textDocument/didChange",
  (params: { textDocument: { uri: string }; contentChanges: { text: string }[] }) =>
    publish(params.textDocument.uri, params.contentChanges.at(-1)?.text ?? ""),
)
connection.onRequest("textDocument/hover", () => ({ contents: { kind: "markdown", value: "a fake symbol" } }))
connection.listen()
