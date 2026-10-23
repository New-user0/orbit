export * as MemoryInstructions from "./instructions.js"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Hash } from "@orbit/util/hash"
import { heading, neutralize } from "@orbit/util/reminder-text"
import { Bus } from "../bus.js"
import { ConfigInstructionFile } from "../config/instruction-file.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { Location } from "../location.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
import { MemoryStore } from "./store.js"

/**
 * The two instruction sources of memory. `core/memory-guide` tells the main thread how memory works and where its folder
 * is; `core/memory-index` carries `MEMORY.md`, which the model keeps itself. A session keeps the index it first read
 * until its compaction completes or the instruction files are rescanned, so a note the model writes during a session
 * does not come back to it as an update, and a later session or the next epoch sees it.
 */

const GUIDE = Instructions.Key.make("core/memory-guide")
const INDEX = Instructions.Key.make("core/memory-index")

// The events after which a session's frozen index goes: a completed compaction moves its epoch, and a session that is
// deleted or moves to another place no longer reads this Location's index.
const released = Schema.is(Schema.Union([SessionEvent.Compaction.Ended, SessionEvent.Deleted, SessionEvent.Moved]))

const Index = Schema.Struct({ path: Schema.String, content: Schema.String })
type Index = typeof Index.Type

export interface LoadInput {
  readonly sessionID: SessionSchema.ID
  /** The guide is for the main thread, and not under a system prompt that replaces Orbit's. */
  readonly guide: boolean
  /** The index goes wherever instruction files do. */
  readonly index: boolean
}

export interface Interface {
  readonly load: (input: LoadInput) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/MemoryInstructions") {}

// The sentence that the removed Memory tool wrote under the heading of the index it generated, byte for byte.
const TOOL_HEADER =
  "# Project memory\nNotes saved in earlier sessions with the Memory tool. Read one with Memory read before relying on details.\n"

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const bus = yield* Bus.Service
    const discovery = yield* InstructionDiscovery.Service
    const index = path.join(store.folder, MemoryStore.ENTRYPOINT)

    // The index the removed tool generated stays as the model's starting index, without the line that names the tool.
    // Only a file whose real place is in the folder is changed, and only when it starts with the tool's own words.
    yield* Effect.gen(function* () {
      const real = yield* store.locate(index)
      if (real === undefined) return
      const text = yield* fs.readFileString(real)
      if (text.startsWith(TOOL_HEADER))
        yield* fs.writeFileString(real, `# Project memory\n${text.slice(TOOL_HEADER.length)}`)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory index header not rewritten", { cause })))

    yield* carryOver(fs, global, location)

    // The index each session read, until its epoch moves or the session is gone from this Location. The listener runs
    // inside the publish of the event, so the next read after a completed compaction finds the entry gone.
    const frozen = new Map<string, Index | Instructions.Removed>()
    const unsubscribe = yield* bus.listen((event) =>
      released(event) ? Effect.sync(() => frozen.delete(event.data.sessionID)) : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* discovery.addRescan(Effect.sync(() => frozen.clear()))

    let warned = false
    const ensureFolder = fs.makeDirectory(store.folder, { recursive: true }).pipe(
      Effect.catchCause((cause) =>
        warned
          ? Effect.void
          : Effect.sync(() => {
              warned = true
            }).pipe(Effect.andThen(Effect.logWarning("memory folder not created", { folder: store.folder, cause }))),
      ),
    )

    const readIndex = Effect.gen(function* () {
      const real = yield* store.locate(index)
      if (real === undefined) return Instructions.removed
      const text = yield* fs.readFileString(real).pipe(Effect.orElseSucceed(() => ""))
      const content = ConfigInstructionFile.parse(text, { frontmatter: true }).content
      if (content.trim() === "") return Instructions.removed
      return { path: index, content: MemoryStore.truncateIndex(content).content }
    })

    const load = Effect.fn("MemoryInstructions.load")(function* (input: LoadInput) {
      const guide = Instructions.make({
        key: GUIDE,
        codec: Schema.toCodecJson(Schema.String),
        read: Effect.gen(function* () {
          if (!input.guide || !(yield* store.enabled())) return Instructions.removed
          // The guide tells the model that the folder exists, so it never spends a step making it.
          yield* ensureFolder
          return store.folder
        }),
        render: {
          initial: renderGuide,
          changed: (_previous, folder) => renderGuide(folder),
          removed: () => "Memory is switched off for this session: do not read or write memory files.",
        },
      })
      const memoryIndex = Instructions.make({
        key: INDEX,
        codec: Schema.toCodecJson(Index),
        read: Effect.gen(function* () {
          if (!input.index || !(yield* store.enabled())) return Instructions.removed
          const kept = frozen.get(input.sessionID)
          if (kept !== undefined) return kept
          const value = yield* readIndex
          frozen.set(input.sessionID, value)
          return value
        }),
        render: {
          initial: renderIndex,
          changed: (_previous, value) => `The memory index changed.\n\n${renderIndex(value)}`,
          removed: () => "The memory index loaded earlier no longer applies.",
        },
      })
      return Instructions.combine([guide, memoryIndex])
    })

    return Service.of({ load })
  }),
)

const renderIndex = (value: Index) =>
  `Contents of ${heading(value.path)}, the person's auto-memory index. It lists the memories kept for this project in earlier conversations; each entry points to a file in the same folder:\n\n${neutralize(value.content)}`

// A repository with no remote is named by its path until it is trusted and by its first commit afterwards, and a
// Location keeps the ID it was bound with, so notes the model wrote before trust sit in a folder named by the path. They
// move to the project's folder, a note that already has its name there wins, and the index gets a line for each note it
// does not point to yet. The IDs joined into paths are Orbit's own hashes and project IDs, never a name from a file
// (class 5).
const carryOver = (fs: FSUtil.Interface, global: Global.Interface, location: Location.Interface) =>
  Effect.gen(function* () {
    const target = path.join(global.data, "memory", location.project.id)
    const legacy = [
      ...new Set([
        ...[location.project.directory, location.project.canonical].map((folder) => Hash.fast(`directory:${folder}`)),
        ...(location.previousProjectID ? [location.previousProjectID] : []),
      ]),
    ]
      .map((id) => path.join(global.data, "memory", id))
      .filter((folder) => folder !== target)
    const moved = yield* Effect.forEach(legacy, (folder) =>
      Effect.gen(function* () {
        const names = (yield* fs.readDirectory(folder)).filter(
          (file) => file.endsWith(".md") && file !== MemoryStore.ENTRYPOINT,
        )
        if (names.length === 0) return []
        yield* fs.ensureDir(target)
        const done = yield* Effect.forEach(names, (file) =>
          fs
            .existsSafe(path.join(target, file))
            .pipe(
              Effect.flatMap((exists) =>
                exists
                  ? Effect.succeed([])
                  : fs.rename(path.join(folder, file), path.join(target, file)).pipe(Effect.as([file])),
              ),
            ),
        )
        yield* fs.remove(path.join(folder, MemoryStore.ENTRYPOINT)).pipe(Effect.ignore)
        return done.flat()
      }).pipe(Effect.orElseSucceed(() => [] as string[])),
    )
    const files = moved.flat()
    if (files.length === 0) return
    const index = path.join(target, MemoryStore.ENTRYPOINT)
    // The index is written where it really is, and only when that is in the folder: a link named MEMORY.md is left alone.
    const real = (yield* fs.existsSafe(index)) ? yield* fs.realPath(index) : index
    if (!FSUtil.contains(yield* fs.realPath(target), real) && real !== index) return
    const current = (yield* fs.readFileStringSafe(real)) ?? ""
    const lines = yield* Effect.forEach(
      files.filter((file) => !current.includes(`](${file})`)),
      (file) =>
        fs
          .readFileStringSafe(path.join(target, file))
          .pipe(Effect.map((text) => `- [${file.slice(0, -3)}](${file}): ${summary(text ?? "")}`)),
    )
    if (lines.length === 0) return
    const separator = current === "" || current.endsWith("\n") ? "" : "\n"
    yield* fs.writeWithDirs(real, `${current}${separator}${lines.join("\n")}\n`)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory notes from before trust not moved", { cause })))

function summary(text: string) {
  const line = text.split("\n").find((item) => item.trim()) ?? ""
  return line
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 150)
}

// The guide follows the reference's section order and what each section asks of the model, in Orbit's own words.
const renderGuide = (folder: string) => `# Memory

You have a memory that lasts between conversations: a folder of Markdown files at \`${heading(folder)}\`. The folder already exists, so write to it directly with Write and Edit; do not create it or check that it is there.

Use it to build up, over time, a picture of who the person is, how they like to work, what to repeat and what to avoid, and the context of the work you do together, so that a later conversation starts where this one leaves off.

When the person asks you to remember something, save it right away. When they ask you to forget something, find it and remove it.

## Kinds of memory

Each memory is one of four kinds.

### \`user\`
- What it holds: who the person is, their role, what they know well and what is new to them, how they like to collaborate.
- When to save: when you learn something about them that would change how you work with them.
- How to use: fit explanations, the level of detail and the choices you make to the person.
- Examples:
  - person: "I'm a statistician, so the models are fine, but containers are new to me." → save a \`user\` memory: at home with statistics, new to containers; spell out the container steps and skip the statistics.
  - person: "I look after the documentation site and rarely open the server code." → save a \`user\` memory: works mostly on the docs; say more about it when a change reaches the server.

### \`feedback\`
- What it holds: guidance the person gave on how you work, both corrections and approaches they confirmed.
- When to save: when they correct you, or say that something you did was right in a way that was not obvious.
- How to use: follow it, so they never have to say it twice.
- Shape: the rule, then a line "Why:" with the reason they gave, then a line "How to apply:" with when it applies.
- Examples:
  - person: "Please stop ending each reply with a recap, I read the diff myself." → save a \`feedback\` memory: no closing recap after a change. Why: the person reads the diff. How to apply: the last message of every finished change.
  - person: "Good call putting the schema change in its own commit." → save a \`feedback\` memory: a schema change gets a commit of its own. Why: it can be reviewed and reverted alone. How to apply: any change that alters the stored data's shape.

### \`project\`
- What it holds: facts about the work that the code and its history do not show: goals, deadlines, decisions, who is doing what and why.
- When to save: when you learn such a fact. Turn relative dates into absolute ones ("Thursday" becomes the date), so the memory still reads right later.
- How to use: understand the reasons behind a request and make suggestions that fit them.
- Shape: the fact or decision, then a line "Why:", then a line "How to apply:".
- Examples:
  - person: "We show the importer to the pilot customers in two weeks." → save a \`project\` memory: the importer demo is on the date two weeks from today. Why: pilot customers see it then. How to apply: put importer bugs ahead of other work until that day.
  - person: "Priya owns the billing service, so ask her before changing its API." → save a \`project\` memory: Priya owns billing and approves changes to its API. How to apply: name her when a change touches that API.

### \`reference\`
- What it holds: where to find information that lives outside the project: a tracker, a dashboard, a channel, a document.
- When to save: when the person tells you where something is kept.
- How to use: look there when the question is about what it holds.
- Examples:
  - person: "Customer bug reports land in the support-escalations channel first." → save a \`reference\` memory: the first copy of a customer's bug report is in that channel.
  - person: "Our API naming rules are in the style guide linked from the wiki's home page." → save a \`reference\` memory: read that style guide before naming a new endpoint.

## What not to save

- Anything the code, the project's files or the version history already tell: structure, conventions, file locations, who changed what.
- How a bug was fixed: the fix is in the code and the commit message says why.
- Anything already in the instruction files.
- The state of the task at hand: what you are doing now and what is left belongs to this conversation only.

This holds even when the person asks you to save such a thing. Then ask what about it was surprising or worth keeping, and save that instead.

## How to save a memory

Saving takes two steps.

1. Create one file per memory, give it a name that says its topic, and start it with this front matter:

\`\`\`markdown
---
name: <a short name>
description: <one line that says what the memory is about, used to judge later whether it is relevant>
type: <user, feedback, project or reference>
---

<the memory; for feedback and project, the rule or fact, then "Why:" and "How to apply:" lines>
\`\`\`

2. Add a line for it to \`MEMORY.md\` in the same folder: a link to the file and a few words on what it holds, under about 150 characters. \`MEMORY.md\` is an index, not a memory: it has no front matter and never holds the content of a memory.

\`MEMORY.md\` is loaded into every conversation, and the part past 200 lines is cut off, so keep it short. Keep the name, description and type of each file current. Organise memories by topic rather than by date. Change or remove a memory that turns out to be wrong or out of date, and do not write one that repeats another: update the existing one. Use Write to create a file and Edit to change one.

## When to use memory

- Look at your memories when they seem relevant to the task, or when the person refers to earlier work.
- When the person asks you to check, recall or remember something, you must look.
- When the person tells you to ignore memory, act as if the folder were empty, and do not mention or use what it holds.
- Memories go out of date. If a memory conflicts with what you see now, trust what you see now, and fix or remove the memory.

## Before acting on a memory

Treat what a memory says about the code as true on the day it was saved, not today. When it mentions a file, a function or a setting, open the file or search for the name before you rely on it or suggest it to the person. When it describes how the repository looks, read the code and the version history instead, and go with them where they disagree.

## Memory, plans and tasks

Memory is for what a later conversation needs to know. When you and the person need to agree on how to do the work at hand, use a plan. To keep track of progress through the steps of the current work, use the task list. Neither belongs in memory.`

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [MemoryStore.node, FSUtil.node, Global.node, Location.node, Bus.node, InstructionDiscovery.node],
})
