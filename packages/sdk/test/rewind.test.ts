import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import { expect } from "bun:test"
import { LanguageModel, LLMClient } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { TestLLM } from "@orbit/ai/testing"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { Effect, Layer } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const it = testEffect(Layer.empty)

// clients-ux-5: an embedded host reaches the code rewind through the same router and core calls as the server's
// clients (class 12). A real runner, a scripted model whose first tool-advertising request writes `created.txt` with the
// Write tool, and a real git repository: the prompt's own diff names the file, a dry run says what the rewind would
// change, the rewind removes the file and leaves `tracked.txt`, and an undo staged after the file came back removes it
// again.
it.live(
  "an embedded host diffs a prompt alone, rewinds its Write, and stages its undo",
  () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("orbit-embedded-rewind-")),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const sdk = yield* Effect.promise(() => import("../src/effect"))
          const root = yield* Effect.promise(() => fs.realpath(tmp.path))
          const project = path.join(root, "project")
          const created = path.join(project, "created.txt")
          const configDirectory = path.join(root, "config")
          yield* Effect.promise(async () => {
            await fs.mkdir(project, { recursive: true })
            await fs.mkdir(configDirectory)
            await Bun.write(path.join(project, "tracked.txt"), "one\n")
            await $`git init -q`.cwd(project).quiet()
            await $`git -c core.fsmonitor=false add .`.cwd(project).quiet()
          })
          const model = LanguageModel.make({ id: "rewind-test", provider: "test", route: OpenAIChat.route })
          // The first request that offers Write writes the file; everything else, title generation included, is text.
          let written = false
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
          yield* llm.serve((request) => {
            if (written || !request.tools.some((tool) => tool.name === "Write")) return TestLLM.text("done", "answer")
            written = true
            return TestLLM.tool("call-write", "Write", { file_path: "created.txt", content: "one\ntwo\n" })
          })
          const models = Layer.mock(SessionRunnerModel.Service, {
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(model, {
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  cost: [],
                  limit: { context: 100_000, output: 1_000 },
                }),
              ),
          })
          const orbit = yield* sdk.Orbit.create(
            {
              config: { directory: configDirectory, project: false, content: "{}" },
              models: { fetch: false },
              fs: { filewatcher: false },
              trust: { implicit: true },
            },
            {
              overrides: [
                llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
                SessionRunnerModel.node.replace(models),
              ],
            },
          )
          const session = yield* orbit.sessions.create({
            location: sdk.Location.Ref.make({ directory: sdk.AbsolutePath.make(project) }),
          })
          yield* orbit.sessions.prompt({ sessionID: session.id, text: "Write created.txt" })
          yield* orbit.sessions.wait({ sessionID: session.id })
          expect(written).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(created).text())).toBe("one\ntwo\n")
          const prompt = (yield* orbit.sessions.context({ sessionID: session.id })).find(
            (message) => message.type === "user",
          )
          if (!prompt) throw new Error("the prompt is missing")

          const diff = yield* orbit.sessions.diff({ sessionID: session.id, from: prompt.id, scope: "prompt" })
          expect(diff.map((file) => [file.file, file.status])).toEqual([["created.txt", "added"]])

          expect(
            yield* orbit.sessions.revert.files({ sessionID: session.id, messageID: prompt.id, dryRun: true }),
          ).toEqual({ canRewind: true, filesChanged: [created], insertions: 0, deletions: 2 })
          expect(yield* orbit.sessions.revert.files({ sessionID: session.id, messageID: prompt.id })).toEqual({
            canRewind: true,
          })
          expect({
            created: yield* Effect.promise(() => Bun.file(created).exists()),
            tracked: yield* Effect.promise(() => Bun.file(path.join(project, "tracked.txt")).text()),
          }).toEqual({ created: false, tracked: "one\n" })

          yield* Effect.promise(() => Bun.write(created, "again\n"))
          const staged = yield* orbit.sessions.revert.stage({ sessionID: session.id, messageID: prompt.id })
          expect(staged.messageID).toBe(prompt.id)
          expect(yield* Effect.promise(() => Bun.file(created).exists())).toBe(false)
        }),
      ),
    ),
  30_000,
)
