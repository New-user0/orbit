import fs from "fs/promises"
import path from "path"
import { expect } from "bun:test"
import { LanguageModel, LLMClient } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { TestLLM } from "@orbit/ai/testing"
import { llmClient } from "@orbit/core/effect/app-node-platform"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { Effect, Layer, Schedule } from "effect"
import { testEffect } from "../../core/test/lib/effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"

const it = testEffect(Layer.empty)

// clients-ux-15: an embedded host answers Write and Edit approvals with the person's own version of the file through the
// same client, route and Permission service as the server's clients. A reply that gives that version with "always" is
// the protocol's typed refusal and the question stays; each "once" reply that follows writes the person's version, not
// the model's proposal.
it.live(
  "an embedded host answers Write and Edit approvals once with the person's own version",
  () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir("orbit-embedded-revise-")),
      (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const sdk = yield* Effect.promise(() => import("../src/effect"))
          const root = yield* Effect.promise(() => fs.realpath(tmp.path))
          const project = path.join(root, "project")
          const configDirectory = path.join(root, "config")
          yield* Effect.promise(() => Promise.all([fs.mkdir(project), fs.mkdir(configDirectory)]))
          const model = LanguageModel.make({ id: "revise-test", provider: "test", route: OpenAIChat.route })
          // The first request that offers the file tools proposes a Write, the next one an Edit of that file; everything
          // else, title generation included, is text.
          const proposals = [
            TestLLM.tool("call-write", "Write", { file_path: "a.txt", content: "proposed\n" }),
            TestLLM.tool("call-edit", "Edit", { file_path: "a.txt", old_string: "revised", new_string: "proposed" }),
          ]
          const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
          yield* llm.serve((request) =>
            request.tools.some((tool) => tool.name === "Write")
              ? (proposals.shift() ?? TestLLM.text("done", "answer"))
              : TestLLM.text("done", "answer"),
          )
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
              config: {
                directory: configDirectory,
                project: false,
                // Every call asks, so the Write has a question to answer.
                content: JSON.stringify({ permissions: [{ action: "*", resource: "*", effect: "ask" }] }),
              },
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
          yield* orbit.sessions.prompt({ sessionID: session.id, text: "Write a.txt, then edit it" })
          // The next file question other than `skip`, which is already answered.
          const asked = (skip?: string) =>
            orbit.permission.list({ sessionID: session.id }).pipe(
              Effect.flatMap((requests) => {
                const found = requests.find((item) => item.action === "Edit" && item.id !== skip)
                return found ? Effect.succeed(found) : Effect.fail("no file question yet")
              }),
              Effect.retry(Schedule.spaced("20 millis")),
              Effect.timeout("20 seconds"),
            )
          const request = yield* asked()
          expect(request.revisable).toBe(true)

          const refused = yield* orbit.permission
            .reply({ sessionID: session.id, requestID: request.id, decision: "always", content: "revised\n" })
            .pipe(Effect.flip)
          expect(refused).toMatchObject({
            _tag: "InvalidRequestError",
            field: "content",
            message: "Revised content can only be given with a once reply",
          })
          expect((yield* orbit.permission.list({ sessionID: session.id })).map((item) => item.id)).toContain(request.id)

          yield* orbit.permission.reply({
            sessionID: session.id,
            requestID: request.id,
            decision: "once",
            content: "revised\n",
          })
          // The Edit that follows is asked about the file the person wrote, and takes their version too.
          const edit = yield* asked(request.id)
          expect(yield* Effect.promise(() => Bun.file(path.join(project, "a.txt")).text())).toBe("revised\n")
          expect(edit.revisable).toBe(true)
          yield* orbit.permission.reply({
            sessionID: session.id,
            requestID: edit.id,
            decision: "once",
            content: "mine\n",
          })
          yield* orbit.sessions.wait({ sessionID: session.id })
          expect(yield* Effect.promise(() => Bun.file(path.join(project, "a.txt")).text())).toBe("mine\n")
        }),
      ),
    ),
  30_000,
)
