import { expect, test } from "bun:test"
import path from "node:path"
import { formatPath } from "../../src/util/path-format"

// The tools read a leading `~` as the home folder and a Git Bash drive spelling as that drive (FSUtil.resolveFrom), so a
// path in a tool's input is shown where the tool acts on it: `~/../test/x` is the home folder's `x`, not `test/x` in the
// project.
test.each([
  ["~", "~"],
  ["~/notes.md", "~/notes.md"],
  ["~/../test/.config/orbit/orbit.json", "~/.config/orbit/orbit.json"],
  ["~draft.md", "~draft.md"],
  ["src/../src/a.ts", "src/a.ts"],
  ...(process.platform === "win32"
    ? [
        ["~\\notes.md", "~/notes.md"],
        [`/${path.resolve("/home/test")[0]!.toLowerCase()}/home/test/notes.md`, "~/notes.md"],
      ]
    : []),
])("shows %s where a tool acts on it", (input, shown) => {
  const base = path.resolve("/work/project")
  const home = path.resolve("/home/test")
  expect(formatPath(input, { base, home, forwardSlashes: true })).toBe(shown)
  // Without abbreviation the place is spelled out in full.
  if (input.startsWith("~/")) {
    expect(formatPath(input, { base, tilde: home, forwardSlashes: true })).toBe(
      path.resolve(home, input.slice(2)).replaceAll("\\", "/"),
    )
  }
})

test("formats relative, home, and foreign paths", () => {
  expect(formatPath(".", { base: "/work/project" })).toBe(".")
  expect(formatPath("../shared/a.ts", { base: "/work/project" })).toBe("/work/shared/a.ts")
  expect(formatPath("/home/test/project", { base: "/work", home: "/home/test" })).toBe("~/project")
  expect(formatPath("src\\a.ts", { base: "/work", forwardSlashes: true })).toBe("src/a.ts")
  expect(formatPath("C:/", { base: "/work" })).toBe("C:/")
  expect(formatPath("C:\\Users\\tester", { base: "/work", forwardSlashes: true })).toBe("C:/Users/tester")
  expect(formatPath("..\\shared\\a.ts", { base: "C:\\work\\project", forwardSlashes: true })).toBe(
    "C:/work/shared/a.ts",
  )
  expect(formatPath("C:\\Users\\test\\project", { base: "C:\\work", home: "C:\\Users\\test" })).toBe("~/project")
})
