import { resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { Global } from "@orbit/util/global"
import {
  completedToolUpdate,
  declaredFields,
  errorToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  toLocations,
  toToolKind,
} from "../../src/acp/tool"

// The metadata an Edit records once it has run: the diff of the one line it changed, which a completed call shows.
const ran = (before: string, after: string) => ({
  files: [{ file: "file", patch: `--- file\n+++ file\n@@ -1,1 +1,1 @@\n-${before}\n+${after}\n` }],
})

describe("acp tools", () => {
  test("keeps the pages of a Read in its declared fields and drops keys a model added", () => {
    expect(declaredFields("Read", { file_path: "a.pdf", pages: "1-5", sneaky: "x" })).toEqual({
      file_path: "a.pdf",
      pages: "1-5",
    })
  })

  test("keeps the domain lists of a WebSearch under their snake_case names and drops keys a model added", () => {
    expect(
      declaredFields("WebSearch", {
        query: "q",
        allowed_domains: ["a.test"],
        blocked_domains: ["b.test"],
        allowedDomains: ["c.test"],
        sneaky: "x",
      }),
    ).toEqual({ query: "q", allowed_domains: ["a.test"], blocked_domains: ["b.test"] })
  })

  test("maps Orbit tool ids to ACP tool kinds", () => {
    expect(toToolKind("bash")).toBe("execute")
    expect(toToolKind("shell")).toBe("execute")
    expect(toToolKind("webfetch")).toBe("fetch")
    expect(toToolKind("edit")).toBe("edit")
    expect(toToolKind("apply_patch")).toBe("edit")
    expect(toToolKind("patch")).toBe("edit")
    expect(toToolKind("write")).toBe("edit")
    expect(toToolKind("grep")).toBe("search")
    expect(toToolKind("glob")).toBe("search")
    expect(toToolKind("context7_resolve_library_id")).toBe("search")
    expect(toToolKind("context7_get_library_docs")).toBe("search")
    expect(toToolKind("read")).toBe("read")
    expect(toToolKind("task")).toBe("think")
    expect(toToolKind("custom_tool")).toBe("other")
  })

  test.each(["shell", "Bash", "PowerShell"])("treats %s as the shell", (name) => {
    expect(toToolKind(name)).toBe("execute")
    expect(toLocations(name, { command: "ls" }, "/workspace")).toEqual([{ path: "/workspace" }])
    expect(
      pendingToolCall({ toolCallId: "call", toolName: name, state: { input: { command: "ls" } }, cwd: "/workspace" }),
    ).toMatchObject({
      title: "ls",
      kind: "execute",
      locations: [{ path: "/workspace" }],
      rawInput: { cwd: "/workspace" },
    })
  })

  // The shell tools declare `workdir`; a `cwd` or `cmd` the model adds to its input neither moves the command nor names it.
  test.each(["Bash", "PowerShell"])("a %s call shows the folder it runs in, not a cwd the model added", (name) => {
    const input = { command: "sh setup.sh", cwd: "/decoy", cmd: "rm -rf /" }
    expect(toLocations(name, input, "/workspace")).toEqual([{ path: "/workspace" }])
    expect(pendingToolCall({ toolCallId: "call", toolName: name, state: { input }, cwd: "/workspace" })).toMatchObject({
      title: "sh setup.sh",
      locations: [{ path: "/workspace" }],
      rawInput: { command: "sh setup.sh", cwd: "/workspace", cmd: "rm -rf /" },
    })
    expect(
      pendingToolCall({
        toolCallId: "call",
        toolName: name,
        state: { input: { ...input, workdir: "sub" } },
        cwd: "/workspace",
      }).rawInput,
    ).toEqual({ command: "sh setup.sh", workdir: "sub", cmd: "rm -rf /" })
  })

  // An absolute path is shown as the tools resolve it, which on Windows gives a rooted path the session folder's drive.
  test("extracts file locations from tool input", () => {
    expect(toLocations("read", { path: "/tmp/a.ts" }, "/workspace")).toEqual([{ path: resolve("/tmp/a.ts") }])
    expect(toLocations("edit", { path: "/tmp/b.ts", oldString: "a", newString: "b" }, "/workspace")).toEqual([
      { path: resolve("/tmp/b.ts") },
    ])
    expect(toLocations("write", { path: "/tmp/c.ts", content: "c" }, "/workspace")).toEqual([
      { path: resolve("/tmp/c.ts") },
    ])
    expect(toLocations("read", { filePath: "/tmp/v1.ts" }, "/workspace")).toEqual([{ path: resolve("/tmp/v1.ts") }])
    expect(toLocations("edit", { path: "src/b.ts" }, "/workspace")).toEqual([
      { path: resolve("/workspace", "src/b.ts") },
    ])
    expect(toLocations("grep", { path: "/repo/src" }, "/workspace")).toEqual([{ path: resolve("/repo/src") }])
    expect(toLocations("glob", { path: "/repo/test" }, "/workspace")).toEqual([{ path: resolve("/repo/test") }])
    expect(toLocations("grep", { pattern: "x", path: "src" }, "/workspace")).toEqual([
      { path: resolve("/workspace", "src") },
    ])
    expect(toLocations("glob", { pattern: "*.ts" }, "/workspace")).toEqual([])
    expect(toLocations("context7_get_library_docs", { path: "/docs" }, "/workspace")).toEqual([
      { path: resolve("/docs") },
    ])
    expect(
      toLocations("external_directory", { filepath: "/tmp/outside/a.ts", parentDir: "/tmp/outside" }, "/workspace"),
    ).toEqual([{ path: "/tmp/outside/a.ts" }])
    expect(toLocations("bash", { cmd: "pwd" }, "/workspace")).toEqual([{ path: "/workspace" }])
    expect(toLocations("bash", { command: "pwd", workdir: "subdir" }, "/workspace")).toEqual([
      { path: resolve("/workspace", "subdir") },
    ])
    expect(toLocations("bash", { command: "pwd", workdir: "/abs/dir" }, "/workspace")).toEqual([
      { path: resolve("/abs/dir") },
    ])
    expect(toLocations("read", { path: "/tmp/missing-file-path.ts" }, "/workspace")).toEqual([
      { path: resolve("/tmp/missing-file-path.ts") },
    ])
  })

  // Every spelling of a path that the tools accept, with the place they act on (FileAccess.resolvePath, pinned by
  // packages/core/test/file-access-path.test.ts). A tool call is shown at that place: a leading `~` is the home folder,
  // not a folder named `~` in the project, and a Git Bash drive spelling is the Windows drive.
  describe("shows each spelling of a path at the place the tool acts on", () => {
    const home = Global.Path.home
    const cwd = resolve("/workspace")
    const windows = process.platform === "win32"
    const spellings: ReadonlyArray<readonly [string, string]> = [
      ["~", home],
      ["~/config", resolve(home, "config")],
      ["~\\config", windows ? resolve(home, "config") : resolve(cwd, "~\\config")],
      ["~/../outside", resolve(home, "..", "outside")],
      ["~draft", resolve(cwd, "~draft")],
      ["/c/Users/someone/config", windows ? "C:\\Users\\someone\\config" : "/c/Users/someone/config"],
      ["/C:/Users/someone/config", windows ? "C:\\Users\\someone\\config" : "/C:/Users/someone/config"],
      ["/cygdrive/c/config", windows ? "C:\\config" : "/cygdrive/c/config"],
      ["/mnt/c/config", windows ? "C:\\config" : "/mnt/c/config"],
      ["sub/config", resolve(cwd, "sub", "config")],
      ["../config", resolve(cwd, "..", "config")],
      ["/workspace/src/../../etc/config", resolve("/etc/config")],
      [resolve("/elsewhere/config"), resolve("/elsewhere/config")],
    ]
    const calls: ReadonlyArray<readonly [string, (value: string) => Record<string, unknown>]> = [
      ["Bash", (value) => ({ command: "mv orbit.json orbit.json.bak", workdir: value })],
      ["PowerShell", (value) => ({ command: "Move-Item orbit.json orbit.json.bak", workdir: value })],
      ["Grep", (value) => ({ pattern: "apiKey", path: value })],
      ["Glob", (value) => ({ pattern: "*.json", path: value })],
      ["Read", (value) => ({ file_path: value })],
      ["Write", (value) => ({ file_path: value, content: "{}" })],
      ["Edit", (value) => ({ file_path: value, old_string: "a", new_string: "b" })],
      ["Patch", (value) => ({ patchText: `*** Begin Patch\n*** Add File: ${value}\n+x\n*** End Patch` })],
    ]
    for (const [tool, input] of calls)
      test.each(spellings)(`${tool} %s`, (value, place) => {
        const state = { input: input(value) }
        expect(toLocations(tool, state.input, cwd)).toEqual([{ path: place }])
        expect(pendingToolCall({ toolCallId: "call", toolName: tool, state, cwd }).locations).toEqual([{ path: place }])
        expect(runningToolUpdate({ toolCallId: "call", toolName: tool, state, cwd }).locations).toEqual([
          { path: place },
        ])
        const done = { toolCallId: "call", toolName: tool, input: state.input, content: [], cwd }
        expect(completedToolUpdate(done).locations).toEqual([{ path: place }])
        expect(errorToolUpdate({ ...done, error: "failed" }).locations).toEqual([{ path: place }])
      })

    // Glob searches the session's folder for these, and Bash runs there for an empty `workdir`; neither is a folder.
    test("a Glob path spelled undefined or null and an empty workdir name no other folder", () => {
      expect(toLocations("Glob", { pattern: "*", path: "undefined" }, cwd)).toEqual([])
      expect(toLocations("Glob", { pattern: "*", path: "null" }, cwd)).toEqual([])
      expect(toLocations("Bash", { command: "ls", workdir: "" }, cwd)).toEqual([{ path: cwd }])
    })

    test.each(spellings)("the diff of a completed Edit of %s", (value, place) => {
      expect(
        completedToolUpdate({
          toolCallId: "call",
          toolName: "Edit",
          input: { file_path: value, old_string: "a", new_string: "b" },
          content: [],
          metadata: ran("a", "b"),
          cwd,
        }).content,
      ).toEqual([{ type: "diff", path: place, oldText: "a", newText: "b" }])
    })
  })

  test("extracts patch locations from every hunk in the patch body", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+created",
      "*** Update File: /abs/old.ts",
      "*** Move to: src/moved.ts",
      "@@",
      "-one",
      "+two",
      "*** Update File: src/same.ts",
      "@@",
      "-a",
      "+b",
      "*** Delete File: src/gone.ts",
      "*** Update File: src/new.ts",
      "@@",
      "-created",
      "+changed",
      "*** End Patch",
    ].join("\n")

    expect(toLocations("patch", { patchText }, "/workspace")).toEqual([
      { path: resolve("/workspace", "src/new.ts") },
      { path: resolve("/abs/old.ts") },
      { path: resolve("/workspace", "src/moved.ts") },
      { path: resolve("/workspace", "src/same.ts") },
      { path: resolve("/workspace", "src/gone.ts") },
    ])
    expect(toLocations("apply_patch", { patchText }, "/workspace")).toHaveLength(5)
  })

  test("returns no patch locations when the patch body cannot be parsed", () => {
    expect(toLocations("patch", { patchText: "*** Update File: src/a.ts\n-a\n+b" }, "/workspace")).toEqual([])
    expect(toLocations("patch", { patchText: "*** Begin Patch\nnot a hunk\n*** End Patch" }, "/workspace")).toEqual([])
    expect(toLocations("patch", {}, "/workspace")).toEqual([])
  })

  test("reports resolved locations on completed and failed updates", () => {
    const patchText = ["*** Begin Patch", "*** Add File: src/a.ts", "+a", "*** End Patch"].join("\n")
    expect(
      completedToolUpdate({
        toolCallId: "call",
        toolName: "patch",
        input: { patchText },
        content: [{ type: "text", text: "patched" }],
        cwd: "/workspace",
      }).locations,
    ).toEqual([{ path: resolve("/workspace", "src/a.ts") }])
    expect(
      completedToolUpdate({
        toolCallId: "call",
        toolName: "edit",
        input: { path: "src/b.ts", oldString: "before", newString: "after" },
        content: [],
        metadata: ran("before", "after"),
        cwd: "/workspace",
      }),
    ).toMatchObject({
      locations: [{ path: resolve("/workspace", "src/b.ts") }],
      content: [{ type: "diff", path: resolve("/workspace", "src/b.ts"), oldText: "before", newText: "after" }],
    })
    expect(
      errorToolUpdate({
        toolCallId: "call",
        toolName: "write",
        input: { path: "src/c.ts", content: "c" },
        error: "denied",
        cwd: "/workspace",
      }).locations,
    ).toEqual([{ path: resolve("/workspace", "src/c.ts") }])
  })

  test("builds completed content with text and image attachments", () => {
    const image = Buffer.from("image-data").toString("base64")

    expect(
      completedToolUpdate({
        toolCallId: "tool-1",
        cwd: "/workspace",
        toolName: "edit",
        input: {
          path: "/tmp/file.ts",
          oldString: "before",
          newString: "after",
        },
        content: [
          { type: "text", text: "edited /tmp/file.ts" },
          { type: "file", mime: "image/png", name: "image.png", uri: `data:image/png;base64,${image}` },
          { type: "file", mime: "text/plain", name: "note.txt", uri: "data:text/plain;base64,bm90ZQ==" },
        ],
        metadata: ran("before", "after"),
      }).content,
    ).toEqual([
      {
        type: "content",
        content: { type: "text", text: "edited /tmp/file.ts" },
      },
      {
        type: "diff",
        path: resolve("/tmp/file.ts"),
        oldText: "before",
        newText: "after",
      },
      {
        type: "content",
        content: { type: "image", mimeType: "image/png", data: image },
      },
    ])
  })

  test("omits edit diffs when normalized content does not contain one", () => {
    expect(
      completedToolUpdate({
        toolCallId: "tool-1",
        cwd: "/workspace",
        toolName: "write",
        input: {
          path: "/tmp/file.ts",
          content: "created",
        },
        content: [{ type: "text", text: "wrote /tmp/file.ts" }],
        metadata: {},
      }).content,
    ).toEqual([
      {
        type: "content",
        content: { type: "text", text: "wrote /tmp/file.ts" },
      },
    ])
  })

  test("unwraps read's JSON page envelope instead of showing model-facing formatting", () => {
    expect(
      completedToolUpdate({
        toolCallId: "tool-read",
        cwd: "/workspace",
        toolName: "read",
        input: { path: "/tmp/file.ts" },
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { type: "text-page", content: "first\nsecond", mime: "text/plain", offset: 1, truncated: false },
              null,
              2,
            ),
          },
        ],
      }).content,
    ).toEqual([{ type: "content", content: { type: "text", text: "first\nsecond" } }])

    expect(
      completedToolUpdate({
        toolCallId: "tool-list",
        cwd: "/workspace",
        toolName: "read",
        input: { path: "/tmp" },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              entries: [
                { path: "a.ts", type: "file" },
                { path: "src", type: "directory" },
              ],
            }),
          },
        ],
      }).content,
    ).toEqual([{ type: "content", content: { type: "text", text: "a.ts\nsrc" } }])
  })

  test("sends completed tool calls as partial updates", () => {
    expect(
      pendingToolCall({
        toolCallId: "tool-1",
        cwd: "/workspace",
        toolName: "edit",
        state: {
          input: {
            path: "/tmp/file.ts",
            oldString: "before",
            newString: "after",
          },
        },
      }),
    ).toMatchObject({
      toolCallId: "tool-1",
      status: "pending",
      kind: "edit",
      locations: [{ path: resolve("/tmp/file.ts") }],
      rawInput: {
        path: "/tmp/file.ts",
        oldString: "before",
        newString: "after",
      },
    })

    expect(
      completedToolUpdate({
        toolCallId: "tool-1",
        cwd: "/workspace",
        toolName: "edit",
        input: {
          path: "/tmp/file.ts",
          oldString: "before",
          newString: "after",
        },
        content: [{ type: "text", text: "Edit applied successfully." }],
        metadata: { output: "Edit applied successfully.", ...ran("before", "after") },
      }),
    ).toEqual({
      toolCallId: "tool-1",
      status: "completed",
      locations: [{ path: resolve("/tmp/file.ts") }],
      content: [
        {
          type: "content",
          content: { type: "text", text: "Edit applied successfully." },
        },
        {
          type: "diff",
          path: resolve("/tmp/file.ts"),
          oldText: "before",
          newText: "after",
        },
      ],
      rawOutput: {
        metadata: { output: "Edit applied successfully.", ...ran("before", "after") },
      },
    })
  })

  test("builds running tool updates with normalized content", () => {
    expect(
      runningToolUpdate({
        toolCallId: "call",
        cwd: "/workspace",
        toolName: "read",
        state: { input: { path: "/tmp/a" } },
        content: [{ type: "text", text: "done" }],
      }),
    ).toMatchObject({
      toolCallId: "call",
      status: "in_progress",
      locations: [{ path: resolve("/tmp/a") }],
      content: [{ type: "content", content: { type: "text", text: "done" } }],
    })
  })

  test("builds completed raw output with optional metadata", () => {
    const attachments = [
      {
        type: "file",
        mime: "image/jpeg",
        name: "photo.jpg",
        uri: "data:image/jpeg;base64,AAAA",
      },
    ]

    expect(
      completedToolUpdate({
        toolCallId: "call",
        cwd: "/workspace",
        toolName: "read",
        input: {},
        content: [],
        metadata: { output: "done", metadata: { exit: 0 }, attachments },
      }).rawOutput,
    ).toEqual({
      metadata: { output: "done", metadata: { exit: 0 }, attachments },
    })

    expect(
      completedToolUpdate({
        toolCallId: "call",
        cwd: "/workspace",
        toolName: "read",
        input: {},
        content: [],
      }).rawOutput,
    ).toEqual({})
  })

  test("extracts image attachments only from data URLs", () => {
    expect(
      completedToolUpdate({
        toolCallId: "call",
        cwd: "/workspace",
        toolName: "read",
        input: {},
        content: [
          { type: "file", mime: "image/webp", uri: "data:image/webp;charset=utf-8;base64,AAAA" },
          { type: "file", mime: "image/png", uri: "https://example.com/image.png" },
          { type: "file", mime: "text/plain", uri: "data:text/plain;base64,BBBB" },
        ],
        metadata: {},
      }).content,
    ).toEqual([
      {
        type: "content",
        content: { type: "image", mimeType: "image/webp", data: "AAAA" },
      },
    ])
  })

  test("builds failed tool updates", () => {
    expect(
      errorToolUpdate({
        toolCallId: "call",
        cwd: "/workspace",
        toolName: "read",
        input: { path: "/tmp/a" },
        content: [{ type: "text", text: "partial output" }],
        metadata: { path: "/tmp/a" },
        error: "failed",
      }),
    ).toEqual({
      toolCallId: "call",
      status: "failed",
      kind: "read",
      title: "read",
      locations: [{ path: resolve("/tmp/a") }],
      rawInput: { path: "/tmp/a" },
      content: [
        { type: "content", content: { type: "text", text: "partial output" } },
        { type: "content", content: { type: "text", text: "failed" } },
      ],
      rawOutput: { metadata: { path: "/tmp/a" }, error: "failed" },
    })
  })
})
