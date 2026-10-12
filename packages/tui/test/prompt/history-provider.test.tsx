/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { ConfigProvider } from "../../src/config"
import { TuiPathsProvider } from "../../src/context/runtime"
import { PromptHistoryProvider, usePromptHistory } from "../../src/prompt/history"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("down rejects at the newest history item with an empty prompt", async () => {
  await using tmp = await tmpdir()
  const setup = await renderHistory(tmp.path)
  try {
    setup.history.append({ text: "previous", files: [], agents: [], pasted: [] })

    expect(setup.history.move(1, "")).toBeUndefined()
    expect(setup.history.move(-1, "")?.text).toBe("previous")
    expect(setup.history.move(1, "previous")?.text).toBe("")
  } finally {
    setup.app.renderer.destroy()
  }
})

test("shares prompt history across sessions and the home composer", async () => {
  await using tmp = await tmpdir()
  const setup = await renderHistory(tmp.path)
  try {
    setup.history.append({ text: "a-one", files: [], agents: [], pasted: [] })
    setup.history.append({ text: "b-one", files: [], agents: [], pasted: [] })
    setup.history.append({ text: "a-two", files: [], agents: [], pasted: [] })

    expect(setup.history.move(-1, "")?.text).toBe("a-two")
    expect(setup.history.move(-1, "a-two")?.text).toBe("b-one")
    expect(setup.history.move(-1, "b-one")?.text).toBe("a-one")
  } finally {
    setup.app.renderer.destroy()
  }
})

test("keeps legacy unscoped history on the home composer", async () => {
  await using tmp = await tmpdir()
  const legacy = JSON.stringify({ text: "legacy", files: [], agents: [], pasted: [] }) + "\n"
  const setup = await renderHistory(tmp.path, legacy)
  try {
    expect((await waitForHistory(setup.history))?.text).toBe("legacy")

    expect(setup.history.move(1, "legacy")?.text).toBe("")
  } finally {
    setup.app.renderer.destroy()
  }
})

test("files a sent prompt under its directory and time, and keeps only history_limit entries", async () => {
  await using tmp = await tmpdir()
  const setup = await renderHistory(tmp.path, undefined, 2)
  try {
    const before = Date.now()
    setup.history.append({ text: "one", files: [], agents: [], pasted: [] }, "/work/a")
    setup.history.append({ text: "two", files: [], agents: [], pasted: [] }, "/work/b")
    setup.history.append({ text: "three", files: [], agents: [], pasted: [] }, "/work/a")

    expect(setup.history.entries().map((item) => item.text)).toEqual(["two", "three"])
    expect(setup.history.entries()[1]).toMatchObject({ directory: "/work/a" })
    expect(setup.history.entries()[1]?.time).toBeGreaterThanOrEqual(before)
    expect(setup.history.search("t", "/work/a").map((item) => item.text)).toEqual(["three", "two"])

    // The file is rewritten when the limit trims it, and holds the same two entries.
    const lines = (await savedHistory(tmp.path, (text) => texts(text).join() === "two,three"))
      .trim()
      .split("\n")
    expect(lines.map((item) => JSON.parse(item).text)).toEqual(["two", "three"])
  } finally {
    setup.app.renderer.destroy()
  }
})

test("keeps an image and a large paste in memory but saves neither", async () => {
  await using tmp = await tmpdir()
  const setup = await renderHistory(tmp.path)
  try {
    const big = "x".repeat(5000)
    setup.history.append({
      text: "look [Image 1] [Pasted ~1 lines]",
      files: [{ uri: "data:image/png;base64,AAAA", mention: { start: 5, end: 14, text: "[Image 1]" } }],
      agents: [],
      pasted: [{ text: big, source: { start: 15, end: 32, text: "[Pasted ~1 lines]" } }],
    })

    expect(setup.history.entries()[0]?.files).toHaveLength(1)
    expect(setup.history.entries()[0]?.pasted[0]?.text).toBe(big)
    const saved = await savedHistory(tmp.path, (text) => text.endsWith("\n"))
    expect(saved).not.toContain("data:")
    expect(saved).not.toContain(big)
  } finally {
    setup.app.renderer.destroy()
  }
})

async function renderHistory(root: string, persisted?: string, historyLimit?: number) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  if (persisted) await Bun.write(path.join(state, "prompt-history.jsonl"), persisted)
  let history: ReturnType<typeof usePromptHistory>

  function Consumer() {
    history = usePromptHistory()
    return <box />
  }

  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: root, home: root, state, worktree: root }}>
      <ConfigProvider config={createTuiResolvedConfig({ prompt: { history_limit: historyLimit } })}>
        <PromptHistoryProvider>
          <Consumer />
        </PromptHistoryProvider>
      </ConfigProvider>
    </TuiPathsProvider>
  ))
  await app.renderOnce()
  return { app, history: history! }
}

function texts(content: string) {
  return content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line).text as string]
      } catch {
        return []
      }
    })
}

// The provider saves in the background, one write after another, so the file is read until it holds the finished content
// instead of after a fixed pause (which a loaded machine outlasts).
async function savedHistory(root: string, finished: (text: string) => boolean) {
  const file = Bun.file(path.join(root, "state", "prompt-history.jsonl"))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const text = await file.text().catch(() => "")
    if (finished(text)) return text
    await Bun.sleep(10)
  }
  return file.text()
}

async function waitForHistory(history: ReturnType<typeof usePromptHistory>) {
  for (const _ of Array.from({ length: 100 })) {
    const item = history.move(-1, "")
    if (item) return item
    await Bun.sleep(1)
  }
}
