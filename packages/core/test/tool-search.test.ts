import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Environment } from "@orbit/core/environment/index"
import { FileSystem } from "@orbit/core/filesystem"
import { Location } from "@orbit/core/location"
import { FileAccess } from "@orbit/core/file-access"
import { Permission } from "@orbit/core/permission"
import { Ripgrep } from "@orbit/core/ripgrep"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { GlobTool } from "@orbit/core/tool/plugin/glob"
import { GrepTool } from "@orbit/core/tool/plugin/grep"
import { Tool } from "@orbit/core/tool"
import { Token } from "@orbit/core/util/token"
import { Global } from "@orbit/util/global"
import { FSUtil } from "@orbit/util/fs-util"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity, toolTraits } from "./lib/tool"

const globToolNode = makeLocationNode({
  name: "test/glob-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GlobTool.Plugin)),
  deps: [Tool.node, Environment.node, Ripgrep.node, Location.node, FileAccess.node, Permission.node],
})
const grepToolNode = makeLocationNode({
  name: "test/grep-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(GrepTool.Plugin)),
  deps: [Tool.node, Environment.node, Ripgrep.node, Location.node, FileAccess.node, Permission.node],
})
const sessionID = Session.ID.make("ses_search_tool_test")

const withTools = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
  assertions?: Permission.AssertInput[],
  trusted = true,
  // The person's rules, decided as Permission decides them: a deny refuses the call, and anything else lets it through.
  rules: Permission.Ruleset = [],
) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    expect(yield* toolTraits(registry, "Glob")).toMatchObject({
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      interruptBehavior: "cancel",
    })
    expect(yield* toolTraits(registry, "Grep")).toMatchObject({
      readOnly: true,
      concurrencySafe: true,
      destructive: false,
      interruptBehavior: "cancel",
    })
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, globToolNode, grepToolNode]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Permission.node.replace(
          permissionLayer({
            // A deny of the person's rules, decided without a question.
            denied: (input) =>
              Effect.succeed(
                input.resources.some((resource) => Permission.evaluate(input.action, resource, rules).effect === "deny"),
              ),
            assert: (input) =>
              Effect.sync(() => {
                assertions?.push(input)
              }).pipe(
                Effect.andThen(
                  input.resources.some(
                    (resource) => Permission.evaluate(input.action, resource, rules).effect === "deny",
                  )
                    ? Effect.fail(
                        new Permission.BlockedError({ rules, permission: input.action, resources: input.resources }),
                      )
                    : Effect.void,
                ),
              ),
          }),
        ),
        ...(trusted ? [] : untrustedProjectNodes),
      ]),
    ),
  )

const call = (name: "Glob" | "Grep", input: unknown) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

describe("search tools", () => {
  for (const hidden of [undefined, false, true]) {
    for (const limit of hidden === false ? [1, 10] : [10]) {
      it.live(`glob honors hidden=${hidden} before limit=${limit}`, () =>
        Effect.gen(function* () {
          const tmp = yield* tmpdirScoped()
          yield* Effect.promise(() =>
            Promise.all(
              ["src/visible.ts", ".hidden.ts", "src/.hidden.ts", ".hidden/nested.ts", ".git/config.ts"].map((file) =>
                Bun.write(path.join(tmp.path, file), "needle\n"),
              ),
            ),
          )
          yield* withTools(tmp.path, (registry) =>
            Effect.gen(function* () {
              const result = yield* executeTool(
                registry,
                call("Glob", { pattern: "**/*.ts", limit, ...(hidden === undefined ? {} : { hidden }) }),
              )
              // Hidden files are listed unless the call says `hidden: false`.
              const expected =
                hidden === false
                  ? ["src/visible.ts"]
                  : [".hidden.ts", ".hidden/nested.ts", "src/.hidden.ts", "src/visible.ts"]

              expect(result.status).toBe("completed")
              expect(result.output).toHaveLength(expected.length)
              expect(result.output).toEqual(
                expect.arrayContaining(expected.map((file) => ({ path: path.normalize(file), type: "file" }))),
              )
              expect(result.metadata).toEqual({ count: expected.length, truncated: false })
              expect(result.content).toHaveLength(1)
              expect(result.content?.[0]?.type === "text" ? result.content[0].text.split("\n").sort() : []).toEqual(
                expected.map((file) => path.join(tmp.path, file)).sort(),
              )
            }),
          )
        }),
      )
    }
  }

  // tool-runtime-8: a Grep result above 20,000 characters is saved behind the wrapper, as the reference declares.
  it.live("declares 20,000 characters as Grep's result limit", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          expect((yield* toolTraits(registry, "Grep", { pattern: "needle" })).maxResultChars).toBe(20_000)
        }),
      )
    }),
  )

  it.live("bounds omitted glob and grep limits", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all(
              Array.from({ length: FileSystem.DEFAULT_GREP_LIMIT + 10 }, (_, index) =>
                fs.writeFile(path.join(tmp.path, `${index}.txt`), "needle\n"),
              ),
            ),
          )
          yield* withTools(tmp.path, (registry) =>
            Effect.gen(function* () {
              const glob = yield* executeTool(registry, call("Glob", { pattern: "*" }))
              const grep = yield* executeTool(registry, call("Grep", { pattern: "needle" }))

              expect(glob.metadata).toEqual({ count: FileSystem.DEFAULT_SEARCH_LIMIT, truncated: true })
              expect(grep.metadata).toEqual({ matches: FileSystem.DEFAULT_GREP_LIMIT, truncated: true })
              expect(glob.content).toHaveLength(1)
              expect(grep.content).toHaveLength(1)
              const globText = glob.content?.[0]?.type === "text" ? glob.content[0].text : ""
              const grepText = grep.content?.[0]?.type === "text" ? grep.content[0].text : ""
              expect(globText.split("\n")).toHaveLength(FileSystem.DEFAULT_SEARCH_LIMIT + 2)
              expect(globText).toEndWith(
                `(The list stops at ${FileSystem.DEFAULT_SEARCH_LIMIT} results. Search a narrower folder or use a tighter pattern to see the rest.)`,
              )
              expect(FileSystem.DEFAULT_GREP_LIMIT).toBe(250)
              expect(grepText).toStartWith("Found 250 matches\n")
              expect(grepText).toContain("showing matches 1-250. Use `offset: 250`")
            }),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("pages context-heavy grep results by token budget with no gaps or repeats", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const filler = "x".repeat(300)
      const lines = Array.from({ length: 60 * 60 }, (_, index) => (index % 60 === 0 ? `needle ${index}` : filler))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, "big.txt"), lines.join("\n") + "\n"))
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const seen: number[] = []
          let offset = 0
          let pages = 0
          while (true) {
            const result = yield* executeTool(registry, call("Grep", { pattern: "needle", context: 20, offset }))
            const text = result.content?.[0]?.type === "text" ? result.content[0].text : ""
            const found = (result.output as { line: number; submatches: unknown[] }[])
              .filter((row) => row.submatches.length > 0)
              .map((row) => row.line)
            expect(found.length).toBeGreaterThan(0)
            expect(text.length).toBeLessThan(100_000 + 1_000)
            seen.push(...found)
            pages++
            if (!(result.metadata as { truncated: boolean }).truncated) break
            offset += found.length
            expect(text).toContain(`showing matches ${offset - found.length + 1}-${offset}`)
            expect(text).toContain(`offset: ${offset}`)
          }
          expect(pages).toBeGreaterThan(1)
          expect(seen).toEqual(Array.from({ length: 60 }, (_, index) => index * 60 + 1))
        }),
      )
    }),
  )

  for (const outputMode of ["content", "count"] as const) {
    it.live(`${outputMode} pages across many folders in path order with no gaps or repeats`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const names = Array.from({ length: 8 }, (_, d) => d).flatMap((d) =>
          Array.from({ length: 40 }, (_, f) => `d${d}/f${String(f).padStart(2, "0")}.txt`),
        )
        yield* Effect.promise(() =>
          Promise.all(names.map((name) => Bun.write(path.join(tmp.path, name), "needle\n"))),
        )
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const tail = (file: string) => file.replaceAll("\\", "/").split("/").slice(-2).join("/")
            const paths = (result: { output?: unknown }) =>
              outputMode === "content"
                ? (result.output as { entry: { path: string } }[]).map((row) => tail(row.entry.path))
                : (result.output as { counts: { path: string }[] }).counts.map((row) => tail(row.path))
            const seen: string[] = []
            let first: string[] = []
            let offset = 0
            while (true) {
              const result = yield* executeTool(
                registry,
                call("Grep", { pattern: "needle", outputMode, offset, ...(outputMode === "count" ? { limit: 250 } : {}) }),
              )
              const page = paths(result)
              if (offset === 0) first = page
              seen.push(...page)
              if (!(result.metadata as { truncated: boolean }).truncated) break
              offset += page.length
            }
            expect(first).toEqual(names.toSorted().slice(0, 250))
            expect(seen).toEqual(names.toSorted())
          }),
        )
      }),
    )
  }

  for (const outputMode of ["files_with_matches", "count"] as const) {
    it.live(`${outputMode} names the exact next offset and paging from it neither skips nor repeats`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const limit = 4
        const names = Array.from({ length: limit + 5 }, (_, index) => `f${index}.txt`)
        yield* Effect.promise(() =>
          Promise.all(names.map((name) => Bun.write(path.join(tmp.path, name), "needle\n"))),
        )
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const page = (offset: number) =>
              executeTool(registry, call("Grep", { pattern: "needle", outputMode, limit, offset }))
            const names1 = (result: { output?: unknown }) => {
              const output = result.output as { files?: string[]; counts?: { path: string }[] }
              return output.files ?? output.counts!.map((row) => row.path)
            }
            const seen: string[] = []
            let offset = 0
            const first = yield* page(0)
            const text = first.content?.[0]?.type === "text" ? first.content[0].text : ""
            expect(text).toContain(`offset: ${limit}`)
            expect(text).not.toContain(`offset: ${limit + 1}`)
            while (true) {
              const result = yield* page(offset)
              seen.push(...names1(result))
              if (!(result.metadata as { truncated: boolean }).truncated) break
              offset += limit
            }
            expect(seen.toSorted()).toEqual(names.toSorted())
            expect(seen).toHaveLength(names.length)
            // Paging from the noted offset returns the next full page.
            expect(names1(yield* page(limit))).toEqual(seen.slice(limit, limit * 2))
          }),
        )
      }),
    )
  }

  it.live("reports a match longer than the clipping window as one match", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "min.js"), `import ${"a, ".repeat(400)}b from "x"\n`),
          Bun.write(path.join(tmp.path, "fn.js"), `function big() {\n${"  call()\n".repeat(200)}}\n`),
        ]),
      )
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
            result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : ""
          const single = yield* executeTool(registry, call("Grep", { pattern: "import.*from", path: "min.js" }))
          expect(text(single)).toContain("Found 1 matches")
          expect(single.metadata).toMatchObject({ matches: 1 })
          const multi = yield* executeTool(
            registry,
            call("Grep", { pattern: "function \\w+\\(\\) \\{.*?\\n\\}", multiline: true, path: "fn.js" }),
          )
          expect(text(multi)).toContain("Found 1 matches")
          expect(multi.metadata).toMatchObject({ matches: 1 })
        }),
      )
    }),
  )

  it.live("excludes version-control folders from grep and from glob with hidden", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const dirs = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"]
      yield* Effect.promise(() =>
        Promise.all(
          ["src/visible.ts", ...dirs.map((dir) => `${dir}/nested/inner.ts`)].map((file) =>
            Bun.write(path.join(tmp.path, file), "needle\n"),
          ),
        ),
      )
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const grep = yield* executeTool(registry, call("Grep", { pattern: "needle", outputMode: "files_with_matches" }))
          expect(grep.output).toEqual({ files: [path.normalize("src/visible.ts")] })
          const glob = yield* executeTool(registry, call("Glob", { pattern: "**/*.ts", hidden: true }))
          expect(glob.output).toEqual([{ path: path.normalize("src/visible.ts"), type: "file" }])
        }),
      )
    }),
  )

  for (const [name, prefix] of [
    ["ASCII", "a"],
    ["two-byte", "é"],
    ["astral", "\u{1F600}"],
  ] as const) {
    it.live(`clips a long ${name} line around the first match with offsets into the clipped text`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const line = prefix.repeat(3_000) + "needle" + prefix.repeat(2_000)
        yield* Effect.promise(() => Bun.write(path.join(tmp.path, "long.txt"), line + "\n"))
        yield* withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* executeTool(registry, call("Grep", { pattern: "needle" }))
            const rows = result.output as { text: string; submatches: { text: string; start: number; end: number }[] }[]
            expect(rows).toHaveLength(1)
            const row = rows[0]!
            expect(row.text.length).toBeGreaterThan(500)
            expect(row.text.length).toBeLessThan(560)
            expect(row.text).toContain("[line truncated: ")
            expect(row.text).toContain(`${line.length} chars]`)
            expect(row.submatches).toHaveLength(1)
            expect(row.text.slice(row.submatches[0]!.start, row.submatches[0]!.end)).toBe("needle")
            expect(row.text.includes("�")).toBe(false)
          }),
        )
      }),
    )
  }

  it.live("returns a multiline match of short lines whole and budgets a huge one", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fields = Array.from({ length: 30 }, (_, index) => `  field_${index}: Some<${"x".repeat(30)}>,`)
      const record = `struct S {\n${fields.join("\n")}\n}`
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "s.rs"), `${record}\n`),
          Bun.write(path.join(tmp.path, "big.txt"), `start\n${"line of text\n".repeat(20_000)}end\n`),
        ]),
      )
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
            result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : ""
          const struct = yield* executeTool(
            registry,
            call("Grep", { pattern: "struct S \\{.*?\\n\\}", multiline: true, path: "s.rs" }),
          )
          expect(text(struct)).toContain("field_29: Some<")
          expect(text(struct)).not.toContain("[line truncated")
          const big = yield* executeTool(registry, call("Grep", { pattern: "start.*end", multiline: true, path: "big.txt" }))
          expect(text(big)).toContain("[match continues for")
          expect(Token.estimate(text(big))).toBeLessThanOrEqual(GrepTool.MAX_OUTPUT_TOKENS)
        }),
      )
    }),
  )

  it.live("finds matches next to files that are not valid UTF-8", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "a-latin.txt"), Buffer.from([...Buffer.from("ab "), 0xff, ...Buffer.from(" needle\n")])),
          Bun.write(path.join(tmp.path, "b-clean.txt"), "clean needle\n"),
        ]),
      )
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const result = yield* executeTool(registry, call("Grep", { pattern: "needle" }))
          expect(result.content?.[0]?.type === "text" ? result.content[0].text : "").toContain("Found 2 matches")
        }),
      )
    }),
  )

  it.live("rejects an empty grep pattern", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(yield* executeTool(registry, call("Grep", { pattern: "" }))).toEqual({
              status: "error",
              error: {
                type: "tool.input-invalid",
                message:
                  'Invalid arguments for tool "Grep":\n- pattern: Pattern must not be empty\n\nArguments provided:\n{\n  "pattern": ""\n}\n\nUpdate the arguments and call the tool again.',
              },
            })
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("handles explicit grep file and directory paths", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(tmp.path, "target.txt"), "needle\n"),
            fs.writeFile(path.join(tmp.path, "other.txt"), "needle\n"),
          ]),
        ).pipe(
          Effect.andThen(
            withTools(tmp.path, (registry) =>
              Effect.gen(function* () {
                const file = yield* executeTool(registry, call("Grep", { path: "target.txt", pattern: "needle" }))
                expect(file).toMatchObject({
                  status: "completed",
                  output: [{ entry: { path: "target.txt" }, line: 1, text: "needle\n" }],
                  metadata: { matches: 1, truncated: false },
                })

                const directory = yield* executeTool(registry, call("Grep", { path: ".", pattern: "needle" }))
                expect(directory).toMatchObject({
                  status: "completed",
                  metadata: { matches: 2, truncated: false },
                })
                if (directory.status !== "completed") return
                expect(directory.output).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ entry: expect.objectContaining({ path: "target.txt" }) }),
                    expect.objectContaining({ entry: expect.objectContaining({ path: "other.txt" }) }),
                  ]),
                )
              }),
            ),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports no grep matches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.promise(() => fs.writeFile(path.join(tmp.path, "file.txt"), "haystack\n")).pipe(
          Effect.andThen(withTools(tmp.path, (registry) => executeTool(registry, call("Grep", { pattern: "needle" })))),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toMatchObject({
                status: "completed",
                content: [{ type: "text", text: "No matches found" }],
                metadata: { matches: 0, truncated: false },
              })
            }),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("reports invalid grep regex details", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withTools(tmp.path, (registry) =>
          Effect.gen(function* () {
            const result = yield* executeTool(registry, call("Grep", { pattern: "[" }))
            expect(result).toMatchObject({
              status: "error",
              error: { type: "tool.execution" },
            })
            if (result.status !== "error" || !result.error) return
            expect(result.error.message).toStartWith("Invalid regex pattern:")
            expect(result.error.message).toContain("unclosed character class")
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("requires external_directory approval for external grep files and directories", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const assertions: Permission.AssertInput[] = []
        return Effect.promise(() => fs.writeFile(path.join(outside.path, "outside.txt"), "needle\n")).pipe(
          Effect.andThen(
            withTools(
              active.path,
              (registry) =>
                Effect.gen(function* () {
                  const directory = yield* executeTool(
                    registry,
                    call("Grep", { path: outside.path, pattern: "needle" }),
                  )
                  const file = yield* executeTool(
                    registry,
                    call("Grep", { path: path.join(outside.path, "outside.txt"), pattern: "needle" }),
                  )
                  expect(directory.status).toBe("completed")
                  expect(file.status).toBe("completed")
                }),
              assertions,
            ),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              expect(assertions.map((input) => input.action)).toEqual([
                "external_directory",
                "Read",
                "Grep",
                "external_directory",
                "Read",
                "Grep",
              ])
              expect(assertions[0]?.resources).toEqual([path.join(outside.path, "*").replaceAll("\\", "/")])
              expect(assertions[1]?.resources).toEqual([outside.path.replaceAll("\\", "/")])
              expect(assertions[3]?.resources).toEqual([path.join(outside.path, "*").replaceAll("\\", "/")])
              expect(assertions[4]?.resources).toEqual([path.join(outside.path, "outside.txt").replaceAll("\\", "/")])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  for (const name of ["Glob", "Grep"] as const) {
    it.live(`${name} reports a missing search path`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withTools(tmp.path, (registry) =>
            Effect.gen(function* () {
              const result = yield* executeTool(
                registry,
                call(name, { path: "missing", pattern: name === "Glob" ? "*" : "needle" }),
              )
              expect(result).toEqual({
                status: "error",
                error: { type: "tool.execution", message: "Search path does not exist: missing" },
              })
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  for (const name of ["Glob", "Grep"] as const) {
    it.live(`${name} tells the model that a device path is a device`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withTools(tmp.path, (registry) =>
            Effect.gen(function* () {
              const result = yield* executeTool(
                registry,
                call(name, { path: process.platform === "win32" ? "NUL" : "/dev/zero", pattern: "x" }),
              )
              expect(result).toMatchObject({
                status: "error",
                error: { type: "file.device", message: expect.stringContaining("is a device or stream") },
              })
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    )
  }

  it.live("reports a file used as the glob search path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.promise(() => fs.writeFile(path.join(tmp.path, "file.txt"), "content\n")).pipe(
          Effect.andThen(
            withTools(tmp.path, (registry) => executeTool(registry, call("Glob", { path: "file.txt", pattern: "*" }))),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result).toEqual({
                status: "error",
                error: { type: "tool.execution", message: "Search path is not a directory: file.txt" },
              })
            }),
          ),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("requires external_directory approval for an explicit external glob path", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const assertions: Permission.AssertInput[] = []
        return Effect.promise(() => fs.writeFile(path.join(outside.path, "outside.txt"), "outside\n")).pipe(
          Effect.andThen(
            withTools(
              active.path,
              (registry) => executeTool(registry, call("Glob", { path: outside.path, pattern: "*.txt" })),
              assertions,
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result.status).toBe("completed")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "Read", "Glob"])
              expect(assertions[0]?.resources).toEqual([path.join(outside.path, "*").replaceAll("\\", "/")])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  // A client shows the searched folder from the request, so the request names it as resolved here, whatever spelling
  // the call used: `~` is the home folder (class 8, approval display).
  for (const name of ["Glob", "Grep"] as const)
    it.live(`${name} names the resolved folder on its approval for each path spelling`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) => {
          const rows = [
            { path: `~/${path.relative(Global.Path.home, outside.path)}`, searches: outside.path },
            { path: `../${path.basename(outside.path)}`, searches: outside.path },
            { path: outside.path, searches: outside.path },
            { path: "src", searches: path.join(active.path, "src") },
            ...(process.platform === "win32"
              ? [
                  {
                    path: `/${outside.path[0]!.toLowerCase()}${outside.path.slice(2).replaceAll("\\", "/")}`,
                    searches: outside.path,
                  },
                ]
              : []),
          ]
          return Effect.promise(() => fs.mkdir(path.join(active.path, "src"))).pipe(
            Effect.andThen(
              Effect.forEach(rows, (row) => {
                const assertions: Permission.AssertInput[] = []
                return withTools(
                  active.path,
                  (registry) => executeTool(registry, call(name, { path: row.path, pattern: "needle" })),
                  assertions,
                ).pipe(
                  Effect.tap(() =>
                    Effect.sync(() =>
                      expect([row.path, assertions.find((item) => item.action === name)?.metadata?.path]).toEqual([
                        row.path,
                        row.searches,
                      ]),
                    ),
                  ),
                )
              }),
            ),
          )
        },
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    )

  // A repository that is not trusted ships its links: a search through one asks about the real folder, marked as one a
  // link leads to so that only the person's own rules decide it, and its own approval names that folder. A trusted
  // project's link is its own (class 4, class 8).
  for (const name of ["Glob", "Grep"] as const)
    for (const trusted of [false, true])
      it.live(
        `${name} through a link in ${trusted ? "a trusted project asks about the folder it leads to" : "an untrusted project names the real folder"}`,
        () =>
          Effect.acquireUseRelease(
            Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
            ([active, outside]) => {
              const assertions: Permission.AssertInput[] = []
              return Effect.promise(async () => {
                await fs.writeFile(path.join(outside.path, "outside.txt"), "needle\n")
                await fs.symlink(outside.path, path.join(active.path, "linked"), "junction")
              }).pipe(
                Effect.andThen(
                  withTools(
                    active.path,
                    (registry) =>
                      executeTool(
                        registry,
                        call(name, { path: "linked", pattern: name === "Glob" ? "*.txt" : "needle" }),
                      ),
                    assertions,
                    trusted,
                  ),
                ),
                Effect.tap((result) =>
                  Effect.sync(() => {
                    const real = FSUtil.resolve(outside.path)
                    const folder = path.join(real, "*").replaceAll("\\", "/")
                    expect(result.status).toBe("completed")
                    expect(assertions.map((item) => item.action)).toEqual(
                      ["external_directory", "Read", name],
                    )
                    expect(assertions[0]).toMatchObject({ resources: [folder] })
                    // Only a project that is not trusted marks the folder as one a link leads to.
                    if (trusted) expect(assertions[0]).not.toHaveProperty("escaped")
                    else expect(assertions[0]).toMatchObject({ escaped: [folder] })
                    expect(assertions.find((item) => item.action === name)?.metadata?.path).toBe(real)
                  }),
                ),
              )
            },
            ([active, outside]) =>
              Effect.promise(() =>
                Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
              ),
          ),
      )

  // A search reads what it searches, so the person's Read rules for its path decide it as they decide a Read of that
  // path: a Read deny of `*.env` covers Grep of `.env`, whose own rules key on the pattern, and a Read deny of a folder
  // covers a Glob of it. A Read ask asks about the path; other paths are the controls (class 8).
  const readRule = (resource: string, effect: "deny" | "ask"): Permission.Ruleset => [
    { action: "*", resource: "*", effect: "allow" },
    { action: "Read", resource, effect },
  ]
  const readRows = [
    { name: "Grep", input: { path: ".env", pattern: "API_KEY" }, rules: readRule("*.env", "deny"), expect: "denied" },
    { name: "Grep", input: { path: ".env", pattern: "API_KEY" }, rules: readRule("*.env", "ask"), expect: "asked" },
    { name: "Grep", input: { path: "README.md", pattern: "readme" }, rules: readRule("*.env", "deny"), expect: "done" },
    { name: "Glob", input: { path: "secrets", pattern: "*" }, rules: readRule("secrets", "deny"), expect: "denied" },
    { name: "Glob", input: { path: "secrets", pattern: "*" }, rules: readRule("secrets", "ask"), expect: "asked" },
    { name: "Glob", input: { path: "src", pattern: "*" }, rules: readRule("secrets", "deny"), expect: "done" },
  ] as const
  for (const row of readRows)
    it.live(
      `${row.name} of ${row.input.path} under a Read ${row.rules[1]!.effect} of ${row.rules[1]!.resource} is ${row.expect}`,
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => {
            const assertions: Permission.AssertInput[] = []
            return Effect.promise(async () => {
              await fs.writeFile(path.join(tmp.path, ".env"), "API_KEY=SECRET-MARKER\n")
              await fs.writeFile(path.join(tmp.path, "README.md"), "readme\n")
              await fs.mkdir(path.join(tmp.path, "secrets"))
              await fs.writeFile(path.join(tmp.path, "secrets", "key.pem"), "key\n")
              await fs.mkdir(path.join(tmp.path, "src"))
              await fs.writeFile(path.join(tmp.path, "src", "a.ts"), "a\n")
            }).pipe(
              Effect.andThen(
                withTools(
                  tmp.path,
                  (registry) => executeTool(registry, call(row.name, row.input)),
                  assertions,
                  true,
                  row.rules,
                ),
              ),
              Effect.tap((result) =>
                Effect.sync(() => {
                  const read = assertions.filter((item) => item.action === "Read")
                  expect(read.map((item) => item.resources)).toEqual([[row.input.path]])
                  if (row.expect === "denied") {
                    expect(result.status).toBe("error")
                    expect(assertions.map((item) => item.action)).toEqual(["Read"])
                    expect(JSON.stringify(result)).not.toContain("SECRET-MARKER")
                    expect(JSON.stringify(result)).not.toContain("key.pem")
                  }
                  if (row.expect === "asked") {
                    expect(Permission.evaluate("Read", row.input.path, row.rules).effect).toBe("ask")
                    expect(result.status).toBe("completed")
                  }
                  if (row.expect === "done") expect(result.status).toBe("completed")
                }),
              ),
            )
          },
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
    )

  it.live("globs through an in-location external symlink after asking about the folder it leads to", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        if (process.platform === "win32") return Effect.void
        const assertions: Permission.AssertInput[] = []
        return Effect.promise(async () => {
          await fs.writeFile(path.join(outside.path, "outside.txt"), "outside\n")
          await fs.symlink(outside.path, path.join(active.path, "linked"))
        }).pipe(
          Effect.andThen(
            withTools(
              active.path,
              (registry) => executeTool(registry, call("Glob", { path: "linked", pattern: "*.txt" })),
              assertions,
            ),
          ),
          Effect.tap((result) =>
            Effect.sync(() => {
              expect(result.status).toBe("completed")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "Read", "Glob"])
              expect(result).toMatchObject({
                output: [{ path: path.join("linked", "outside.txt"), type: "file" }],
                content: [{ type: "text", text: path.join(active.path, "linked", "outside.txt") }],
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("grep lists files, counts matches, pages, and shows context", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await Bun.write(path.join(tmp.path, "a.ts"), "one\nneedle a1\ntwo\nthree\nfour\nneedle a2\nfive\n")
        await Bun.write(path.join(tmp.path, "b.py"), "needle b1\n")
        await Bun.write(path.join(tmp.path, "c.ts"), "nothing here\n")
        // Oldest first, so files_with_matches lists b.py before a.ts.
        await fs.utimes(path.join(tmp.path, "a.ts"), new Date(1_000_000), new Date(1_000_000))
        await fs.utimes(path.join(tmp.path, "b.py"), new Date(2_000_000), new Date(2_000_000))
      })
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const text = (result: { content?: readonly { type: string; text?: string }[] }) =>
            result.content?.[0]?.type === "text" ? (result.content[0].text ?? "") : ""

          const files = yield* executeTool(
            registry,
            call("Grep", { pattern: "needle", outputMode: "files_with_matches" }),
          )
          expect(files.output).toEqual({ files: ["b.py", "a.ts"] })
          expect(files.metadata).toEqual({ matches: 2, truncated: false })

          const counts = yield* executeTool(registry, call("Grep", { pattern: "needle", outputMode: "count" }))
          expect(counts.output).toEqual({
            counts: expect.arrayContaining([
              { path: "a.ts", count: 2 },
              { path: "b.py", count: 1 },
            ]),
          })
          expect(counts.metadata).toEqual({ matches: 3, truncated: false })

          const typed = yield* executeTool(registry, call("Grep", { pattern: "needle", type: "py" }))
          expect(typed.metadata).toEqual({ matches: 1, truncated: false })

          const paged = yield* executeTool(
            registry,
            call("Grep", { pattern: "needle", path: "a.ts", offset: 1, limit: 1 }),
          )
          expect(paged.metadata).toEqual({ matches: 1, truncated: false })
          expect(text(paged)).toContain("Line 6: needle a2")
          // The first match, by its text: the output also names the temporary folder, whose random name may hold "a1".
          expect(text(paged)).not.toContain("needle a1")

          const context = yield* executeTool(registry, call("Grep", { pattern: "needle", path: "a.ts", context: 1 }))
          expect(context.metadata).toEqual({ matches: 2, truncated: false })
          expect(text(context)).toContain(
            [
              "  Line 1- one",
              "  Line 2: needle a1",
              "  Line 3- two",
              "  --",
              "  Line 5- four",
              "  Line 6: needle a2",
              "  Line 7- five",
            ].join("\n"),
          )

          const multiline = yield* executeTool(
            registry,
            call("Grep", { pattern: "two.three", path: "a.ts", multiline: true }),
          )
          expect(multiline.metadata).toEqual({ matches: 1, truncated: false })
        }),
      )
    }),
  )

  it.live("glob lists the oldest files first", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        for (const [file, time] of [
          ["old.ts", 1_000_000],
          ["new.ts", 3_000_000],
          ["middle.ts", 2_000_000],
        ] as const) {
          await Bun.write(path.join(tmp.path, file), "x\n")
          await fs.utimes(path.join(tmp.path, file), new Date(time), new Date(time))
        }
      })
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const result = yield* executeTool(registry, call("Glob", { pattern: "**/*.ts" }))
          expect(result.output).toEqual([
            { path: "old.ts", type: "file" },
            { path: "middle.ts", type: "file" },
            { path: "new.ts", type: "file" },
          ])
        }),
      )
    }),
  )

  // FU-M3-305: the listing includes what .gitignore names, and leaves out what the person's Read rules deny.
  it.live("glob lists a file that .gitignore names, and a hidden one", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(tmp.path, ".git"))
        await Bun.write(path.join(tmp.path, ".gitignore"), "ignored.ts\nbuild/\n")
        await Bun.write(path.join(tmp.path, "ignored.ts"), "x\n")
        // A file inside an ignored folder is only listed when the search itself ignores no ignore file.
        await Bun.write(path.join(tmp.path, "build", "inside.ts"), "x\n")
        await Bun.write(path.join(tmp.path, ".dotfile.ts"), "x\n")
        await Bun.write(path.join(tmp.path, "plain.ts"), "x\n")
      })
      yield* withTools(tmp.path, (registry) =>
        Effect.gen(function* () {
          const result = yield* executeTool(registry, call("Glob", { pattern: "**/*.ts" }))
          expect((result.output as ReadonlyArray<{ path: string }>).map((entry) => entry.path).sort()).toEqual([
            ".dotfile.ts",
            path.join("build", "inside.ts"),
            "ignored.ts",
            "plain.ts",
          ])
        }),
      )
    }),
  )

  for (const row of [
    { name: "a Read deny leaves a denied file unlisted", rules: readRuleForGlob("*.env", "deny"), listed: false },
    { name: "a Read ask leaves it listed", rules: readRuleForGlob("*.env", "ask"), listed: true },
    { name: "no rule leaves it listed (control)", rules: [] as Permission.Ruleset, listed: true },
  ] as const)
    it.live(`glob: ${row.name}`, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        yield* Effect.promise(async () => {
          await Bun.write(path.join(tmp.path, ".env"), "API_KEY=SECRET-MARKER\n")
          await Bun.write(path.join(tmp.path, "notes.md"), "notes\n")
        })
        const assertions: Permission.AssertInput[] = []
        yield* withTools(
          tmp.path,
          (registry) =>
            Effect.gen(function* () {
              const result = yield* executeTool(registry, call("Glob", { pattern: "*" }))
              const names = (result.output as ReadonlyArray<{ path: string }>).map((entry) => entry.path).sort()
              expect(names).toEqual(row.listed ? [".env", "notes.md"] : ["notes.md"])
              expect(JSON.stringify(result)).not.toContain("SECRET-MARKER")
              // Nobody is asked about the files that are left out: the one question is the search folder's own.
              expect(assertions.filter((item) => item.action === "Read").map((item) => item.resources)).toEqual([["."]])
            }),
          assertions,
          true,
          row.rules,
        )
      }),
    )

  it.live("glob fills the limit with readable files when a denied one is among the first", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(async () => {
        for (const [file, time] of [
          ["a.env", 1_000_000],
          ["b.env", 2_000_000],
          ["c.ts", 3_000_000],
          ["d.ts", 4_000_000],
        ] as const) {
          await Bun.write(path.join(tmp.path, file), "x\n")
          await fs.utimes(path.join(tmp.path, file), new Date(time), new Date(time))
        }
      })
      yield* withTools(
        tmp.path,
        (registry) =>
          Effect.gen(function* () {
            const result = yield* executeTool(registry, call("Glob", { pattern: "*", limit: 2 }))
            expect(result.output).toEqual([
              { path: "c.ts", type: "file" },
              { path: "d.ts", type: "file" },
            ])
            expect(result.metadata).toEqual({ count: 2, truncated: false })
          }),
        undefined,
        true,
        readRuleForGlob("*.env", "deny"),
      )
    }),
  )
})

function readRuleForGlob(resource: string, effect: "deny" | "ask"): Permission.Ruleset {
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "Read", resource, effect },
  ]
}
