import { expect, test } from "bun:test"
import { DialogIde, DialogIdeOpen, formatFolders } from "../../src/component/dialog-ide"
import type { Editor } from "../../src/editor"
import { renderLocal } from "../fixture/local"

const window = (port: number, name: string, folders: string[], modified = 0): Editor => ({
  port,
  token: "t".repeat(32),
  name,
  folders,
  url: `ws://127.0.0.1:${port}`,
  modified,
})

const here = "/work/app"

test("lists the windows, the current one focused, with a last row for none", async () => {
  await using setup = await renderLocal()
  setup.dialog.replace(() => (
    <DialogIde
      windows={{ matched: [window(1, "Code", [here]), window(2, "Cursor", [here])], unmatched: [], current: 2 }}
      directory={here}
      inEditor
      onSelect={() => {}}
    />
  ))
  const frame = await setup.waitForFrame((frame) => frame.includes("Select an editor"))
  expect(frame).toContain("Code")
  expect(frame).toContain("Cursor")
  expect(frame).toContain("No editor")
  // The folders are not shown while the names tell the windows apart.
  expect(frame).not.toContain("/work/app")
  // The tip is for terminals outside an editor.
  expect(frame).not.toContain("Tip:")
  expect(frame.split("\n").find((line) => line.includes("Cursor"))).toContain("●")
})

test("windows of the same editor are told apart by their folders, shown relative to the session folder", async () => {
  await using setup = await renderLocal()
  setup.dialog.replace(() => (
    <DialogIde
      windows={{
        matched: [window(1, "Code", ["/work/app/packages/a"]), window(2, "Code", ["/work/app"])],
        unmatched: [],
      }}
      directory={here}
      inEditor={false}
      onSelect={() => {}}
    />
  ))
  const frame = await setup.waitForFrame((frame) => frame.includes("Select an editor"))
  expect(frame).toContain(["packages", "a"].join(require("node:path").sep))
  expect(frame).toContain("/work/app")
  expect(frame).toContain("Tip:")
  // With no window chosen yet, "No editor" is where the focus starts.
  expect(frame.split("\n").find((line) => line.includes("No editor"))).toContain("●")
})

test("windows that do not hold the folder are named apart and cannot be chosen; none at all says what is missing", async () => {
  await using setup = await renderLocal()
  const chosen: unknown[] = []
  setup.dialog.replace(() => (
    <DialogIde
      windows={{ matched: [], unmatched: [window(3, "Other", ["/elsewhere"]), window(4, "Third", ["/else"])] }}
      directory={here}
      inEditor
      onSelect={(port) => chosen.push(port)}
    />
  ))
  const frame = await setup.waitForFrame((frame) => frame.includes("Select an editor"))
  expect(frame.replace(/\s+/g, " ")).toContain("No editor with this folder open was found")
  expect(frame.replace(/\s+/g, " ")).toContain("2 windows have no folder that holds this one")
  expect(frame).toContain("Other /elsewhere")
  expect(frame).toContain("Third /else")
  await Bun.sleep(60)
  setup.mockInput.pressEnter()
  await Bun.sleep(60)
  // Only "No editor" is a row, so Enter chooses it.
  expect(chosen).toEqual([undefined])
})

test("the name and folders an editor chose are drawn without control characters", async () => {
  await using setup = await renderLocal()
  setup.dialog.replace(() => (
    <DialogIde
      windows={{
        matched: [window(1, "Co\u001b[2Jde", ["/a\u001b]0;x\u0007"]), window(2, "Co\u001b[2Jde", ["/b"])],
        unmatched: [window(3, "Oth\u001b[31mer", ["/c\u001b[2J"])],
      }}
      directory={here}
      inEditor
      onSelect={() => {}}
    />
  ))
  const frame = await setup.waitForFrame((frame) => frame.includes("Select an editor"))
  expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})

test("the open picker lists the windows with their folders", async () => {
  await using setup = await renderLocal()
  const chosen: number[] = []
  setup.dialog.replace(() => (
    <DialogIdeOpen windows={[window(7, "Cursor", [here])]} directory={here} onSelect={(item) => chosen.push(item.port)} />
  ))
  await setup.waitForFrame((frame) => frame.includes("Open this folder in"))
  await Bun.sleep(80)
  setup.mockInput.pressEnter()
  await Bun.sleep(60)
  expect(chosen).toEqual([7])
})

test("folders: at most two, a hundred columns in all, tails kept, an ellipsis when some were left out", () => {
  const long = (letter: string) => `/${letter.repeat(90)}/project`
  expect(formatFolders(["/work/app"], "/work/app")).toBe("/work/app")
  const line = formatFolders([long("a"), long("b"), "/c"], "/other")
  // Two folders, the third left out: 100 - 2 for the separator - 3 for the mark, split in two.
  expect(line.endsWith("…")).toBe(true)
  const [first, second] = line.slice(0, -1).split(", ")
  expect(first!.length).toBe(47)
  expect(second!.length).toBe(47)
  expect(first!.startsWith("…")).toBe(true)
  expect(first!.endsWith("/project")).toBe(true)
  expect(line.length).toBeLessThanOrEqual(100)
  // Two folders that fit are kept whole, and the mark is absent.
  expect(formatFolders(["/a", "/b"], "/z")).toBe("/a, /b")
})
