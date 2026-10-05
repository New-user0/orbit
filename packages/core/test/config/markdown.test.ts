import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ConfigMarkdown } from "@orbit/core/config/markdown"
import { AgentFile } from "@orbit/core/config/plugin/agent-file"
import { CommandFile } from "@orbit/core/config/plugin/command-file"
import { SkillFile } from "@orbit/core/config/plugin/skill-file"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { scriptedMarkdown } from "../fixture/front-matter"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))

// gray-matter reads all of these as JavaScript, with or without a space after the delimiter.
const languages = ["js", "javascript", "JS", "JavaScript", " js"]

const ran = (marker: string) => Bun.file(marker).exists()

describe("ConfigMarkdown", () => {
  test("reads YAML front matter", () => {
    expect(ConfigMarkdown.parseOption("---\nname: demo\nmetadata:\n  tags: [a, b]\n---\nBody.")).toMatchObject({
      data: { name: "demo", metadata: { tags: ["a", "b"] } },
      content: "Body.",
    })
  })

  for (const language of languages) {
    test(`refuses front matter that opens with ---${language}, and runs nothing`, async () => {
      await using tmp = await tmpdir()
      const marker = path.join(tmp.path, "ran")
      const content = scriptedMarkdown(marker, language)
      expect(ConfigMarkdown.parseOption(content)).toBeUndefined()
      expect(() => ConfigMarkdown.parse(content)).toThrow("JavaScript front matter is not supported")
      expect(await ran(marker)).toBe(false)
    })
  }

  // gray-matter keeps what it parsed by content, and keeps a parse that failed as if it had worked.
  test("reads a file that needs its colons quoted the same way every time", () => {
    const content = "---\ndescription: Use when: it fits\n---\nBody."
    const reads = Array.from({ length: 3 }, () => ConfigMarkdown.parseOption(content))
    for (const read of reads) {
      expect(read).toMatchObject({ data: { description: "Use when: it fits" }, content: "Body." })
    }
  })

  test("skips a file whose front matter cannot be read, every time", () => {
    const content = "---\nmetadata: [\n---\nBody."
    expect(Array.from({ length: 2 }, () => ConfigMarkdown.parseOption(content))).toEqual([undefined, undefined])
  })
})

// The readers of every kind of file that a config directory holds in Markdown, which a cloned repository can fill.
describe("Markdown files with front matter written in JavaScript", () => {
  it.live("define no command, and run nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      const marker = path.join(tmp.path, "ran")
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "commands", "scripted.md"), scriptedMarkdown(marker)),
          Bun.write(path.join(tmp.path, "commands", "plain.md"), "---\ndescription: Plain\n---\nBody."),
        ]),
      )
      expect((yield* CommandFile.load(fs, tmp.path)).map((command) => command.name)).toEqual(["plain"])
      expect(yield* Effect.promise(() => ran(marker))).toBe(false)
    }),
  )

  it.live("define no agent, and run nothing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      const marker = path.join(tmp.path, "ran")
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(tmp.path, "agents", "scripted.md"), scriptedMarkdown(marker)),
          Bun.write(path.join(tmp.path, "agents", "plain.md"), "---\ndescription: Plain\n---\nBody."),
        ]),
      )
      const documents = yield* AgentFile.load(fs, tmp.path)
      expect(documents.flatMap((document) => Object.keys(document.info.agents ?? {}))).toEqual(["plain"])
      expect(yield* Effect.promise(() => ran(marker))).toBe(false)
    }),
  )

  test("define no skill, and run nothing", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "ran")
    expect(SkillFile.parse("/repo/skills", "/repo/skills/scripted/SKILL.md", scriptedMarkdown(marker))).toEqual({
      _tag: "Skipped",
      reason: "markdown",
    })
    expect(await ran(marker)).toBe(false)
  })
})
