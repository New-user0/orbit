import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { permissionAlwaysLines, permissionPresentation } from "../../src/util/permission"
import { formLabel } from "../../src/util/form"

// ESC ] 52 writes the clipboard, CSI 2 K erases the line, and a BEL ends a sequence.
const hostile = "rm x\u001b]52;c;QQ==\u0007\u001b[2K end"
const written = "rm x\\x1b]52;c;QQ==\\x07\\x1b[2K end"

const requests = [
  { action: "shell", resources: [], input: { command: hostile } },
  { action: "shell", resources: [hostile], input: {} },
  { action: "read", resources: [], metadata: { paths: [hostile] } },
  { action: "grep", resources: [hostile], metadata: { path: hostile } },
  { action: "shell", resources: ["ls"], input: { command: "ls" }, metadata: { workdir: hostile } },
  { action: "webfetch", resources: [], metadata: { url: hostile } },
  { action: "websearch", resources: [], input: { query: hostile } },
  { action: "subagent", resources: [], input: { description: hostile } },
  { action: "edit", resources: [], metadata: { paths: ["a.ts"], files: [{ file: "a.ts", patch: hostile }] } },
  { action: hostile, resources: [], input: {} },
]

async function drawn(content: string) {
  const setup = await createTestRenderer({ width: 80, height: 4, remote: true, useThread: false })
  try {
    setup.renderer.root.add(new TextRenderable(setup.renderer, { content }))
    setup.renderer.start()
    await setup.waitForFrame((frame) => frame.includes("rm x"))
    return setup.captureCharFrame()
  } finally {
    setup.renderer.destroy()
  }
}

test("a permission prompt carries no raw control character in any request kind", async () => {
  // The control run: drawn as it came, the hostile command puts a raw ESC into the frame.
  expect(await drawn(hostile)).toContain("\u001b")

  for (const request of requests) {
    const info = permissionPresentation(request)
    const all = [info.title, ...info.lines, info.diff ?? "", info.patch ?? ""].join("\n")
    expect(all).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/)
    expect(all).toContain("\\x1b")
  }

  const frame = await drawn(permissionPresentation(requests[0]!).lines.join("\n"))
  expect(frame).toContain(written)
  expect(frame).not.toContain("\u001b")
})

test("the always-allow patterns and a form label are written out", () => {
  expect(permissionAlwaysLines({ action: "shell", save: [hostile] }).join("\n")).toContain(written)
  expect(permissionAlwaysLines({ action: hostile, save: ["*"] }).join("\n")).not.toContain("\u001b")
  expect(formLabel({ type: "text", key: "k", title: hostile } as never)).toBe(written)
})
