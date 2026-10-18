import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Command } from "@orbit/core/command"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { Mcp } from "@orbit/core/mcp/index"
import { CommandPlugin } from "@orbit/core/plugin/command"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/schema/session"
import { SessionInbox } from "@orbit/schema/session-inbox"
import { SessionMessage } from "@orbit/schema/session-message"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { DateTime } from "effect"
import { emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { slashParity } from "../../../tui/test/fixture/slash-parity"
import { host } from "./host"
import PROMPT_INITIALIZE from "../../src/plugin/command/initialize.txt"
import PROMPT_REVIEW from "../../src/plugin/command/review.txt"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory }, { projectDirectory: project })),
)
const commandLayer = (compat?: Config.Compat) =>
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node]), [
      Mcp.node.replace(emptyMcpLayer),
      Location.node.replace(locationLayer),
    ]),
    Config.testLayer([], compat),
  )
const it = testEffect(commandLayer())
const compatOff = testEffect(commandLayer({ enabled: false, roots: [] }))

// The instruction files /init is told to read: the ones Orbit loads, then (while compatibility is on) other products'.
const files = (names: readonly string[]) => names.map((name) => `\`${name}\``).join(", ")
const everyFile = files([
  "ORBIT.md",
  "AGENTS.md",
  CompatNames.vendor.instructions,
  ...Object.values(CompatNames.foreign).flat(),
])
const initialize = (instructionFiles: string, args: string) =>
  PROMPT_INITIALIZE.replace("${path}", project)
    .replace("${instruction_files}", instructionFiles)
    .replaceAll("$ARGUMENTS", args)

describe("CommandPlugin.Plugin", () => {
  compatOff.effect("leaves other products' instruction files out of /init when compatibility is off", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const prompts: string[] = []
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push(input.text)
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_test"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      yield* command.execute({
        name: "init",
        invocation: { sessionID: Session.ID.make("ses_test"), prompt: { text: "" }, delivery: "steer" },
      })

      expect(prompts).toEqual([initialize(files(["ORBIT.md", "AGENTS.md"]), "")])
      expect(prompts[0]).not.toContain(CompatNames.vendor.instructions)
      for (const name of Object.values(CompatNames.foreign).flat()) expect(prompts[0]).not.toContain(name)
    }),
  )

  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const prompts: {
        text: string
        files?: readonly { readonly uri: string }[]
        delivery?: "steer" | "queue"
      }[] = []
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push({ text: input.text, files: input.files, delivery: input.delivery })
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_test"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "extra context", files: [{ uri: "file:///tmp/context.md" }] },
          delivery: "queue",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "  branch $& $$ $` $'  " },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "" },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "   " },
          delivery: "steer",
        },
      })
      expect(prompts).toEqual([
        {
          text: initialize(everyFile, "extra context"),
          files: [{ uri: "file:///tmp/context.md" }],
          delivery: "queue",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", () => "branch $& $$ $` $'"),
          files: undefined,
          delivery: "steer",
        },
        {
          text: initialize(everyFile, ""),
          files: undefined,
          delivery: "steer",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
      ])
    }),
  )

  // The list of built-ins in the terminal UI's tests names the ones the server registers. A name there that the server
  // does not register would leave a command that people expect with nobody to run it.
  it.effect("registers every built-in that the parity list says the server serves", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )
      const served = slashParity.flatMap((entry) => (entry.state === "server" ? [entry.name] : []))
      // The control: the list does name some, so the loop below checks something.
      expect(served.length).toBeGreaterThan(0)
      for (const name of served) expect(yield* command.get(name)).toMatchObject({ name })
      // And a name that is not registered is not found, so that a typo in the list fails the loop.
      expect(yield* command.get("no-such-built-in")).toBeUndefined()
    }),
  )
})
