export * as MemoryInstructions from "./instructions.js"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Hash } from "@orbit/util/hash"
import { LinkShare } from "@orbit/util/link-share"
import { heading, neutralize } from "@orbit/util/reminder-text"
import { Bus } from "../bus.js"
import { ConfigInstructionFile } from "../config/instruction-file.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { Location } from "../location.js"
import { SessionEvent } from "../session/event.js"
import type { SessionSchema } from "../session/schema.js"
import { MemoryStore } from "./store.js"
import { MemoryTeam } from "./team.js"
import { MemoryAgent } from "./agent.js"
import { ConfigAgent } from "@orbit/schema/config/agent"

/**
 * The instruction sources of memory. `core/memory-guide` tells the main thread how memory works and where its folder
 * is; `core/memory-index` carries `MEMORY.md`, which the model keeps itself, and `core/team-memory-index` the team
 * folder's own `MEMORY.md` while team memory is on (`MemoryTeam`). `core/agent-memory` is the memory of an agent with a
 * memory scope (`MemoryAgent`): the guide under a heading of its own, naming the agent's folder, with the agent's own
 * `MEMORY.md`; it goes with the agent wherever it runs, as the reference appends it to the agent's own prompt. A session
 * keeps each index it first read until its compaction completes or the instruction files are rescanned, so a note the
 * model writes during a session does not come back to it as an update, and a later session or the next epoch sees it.
 */

const GUIDE = Instructions.Key.make("core/memory-guide")
const INDEX = Instructions.Key.make("core/memory-index")
const TEAM_INDEX = Instructions.Key.make("core/team-memory-index")
const AGENT = Instructions.Key.make("core/agent-memory")

// The events after which a session's frozen index goes: a completed compaction moves its epoch, and a session that is
// deleted or moves to another place no longer reads this Location's index.
const released = Schema.is(Schema.Union([SessionEvent.Compaction.Ended, SessionEvent.Deleted, SessionEvent.Moved]))

const Index = Schema.Struct({ path: Schema.String, content: Schema.String })
type Index = typeof Index.Type

// The private folder alone, or both folders while team memory is on.
const Guide = Schema.Union([Schema.String, Schema.Struct({ folder: Schema.String, team: Schema.String })])
type Guide = typeof Guide.Type

// An agent's memory: its id and scope, its folder as spelled, and its index (empty when there is none to read).
const AgentBlock = Schema.Struct({
  agent: Schema.String,
  scope: ConfigAgent.Memory,
  folder: Schema.String,
  index: Schema.String,
})
type AgentBlock = typeof AgentBlock.Type

export interface LoadInput {
  readonly sessionID: SessionSchema.ID
  /** The guide is for the main thread, and not under a system prompt that replaces Orbit's. */
  readonly guide: boolean
  /** The index goes wherever instruction files do. */
  readonly index: boolean
  /** The session's agent: an agent with a memory scope gets its block wherever it runs. */
  readonly agent?: { readonly id: string; readonly memory?: MemoryAgent.Scope }
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
    const teams = yield* MemoryTeam.Service
    const agents = yield* MemoryAgent.Service
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
    const frozenTeam = new Map<string, Index | Instructions.Removed>()
    const frozenAgent = new Map<string, AgentBlock>()
    const unsubscribe = yield* bus.listen((event) =>
      released(event)
        ? Effect.sync(() => {
            frozen.delete(event.data.sessionID)
            frozenTeam.delete(event.data.sessionID)
            frozenAgent.delete(event.data.sessionID)
          })
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    yield* discovery.addRescan(
      Effect.sync(() => {
        frozen.clear()
        frozenTeam.clear()
        frozenAgent.clear()
      }),
    )

    const warned = new Set<string>()
    // A folder whose path has come to cross a link to a share since the Location started is not made, since making it
    // would connect to the host (class 6); that counts as a folder that cannot be made.
    const ensureFolder = (folder: string) =>
      Effect.gen(function* () {
        if (yield* LinkShare.blocked(fs, folder)) return yield* Effect.fail("its path leads to a share")
        yield* fs.makeDirectory(folder, { recursive: true })
      }).pipe(
        Effect.catchCause((cause) =>
          warned.has(folder)
            ? Effect.void
            : Effect.sync(() => warned.add(folder)).pipe(
                Effect.andThen(Effect.logWarning("memory folder not created", { folder, cause })),
              ),
        ),
      )

    // An index is read only where it really is, when that is inside its real folder (`real`, or undefined when it is
    // not), and its front matter is split off without being run (class 11). One that cannot be read is empty (class 7).
    const indexText = (real: string | undefined) =>
      Effect.gen(function* () {
        if (real === undefined) return ""
        const text = yield* fs.readFileString(real).pipe(Effect.orElseSucceed(() => ""))
        const content = ConfigInstructionFile.parse(text, { frontmatter: true }).content
        return content.trim() === "" ? "" : MemoryStore.truncateIndex(content).content
      })
    const readIndex = (file: string, real: string | undefined) =>
      indexText(real).pipe(Effect.map((content) => (content === "" ? Instructions.removed : { path: file, content })))

    const load = Effect.fn("MemoryInstructions.load")(function* (input: LoadInput) {
      // Read once, for both sources and for what the guide says when it goes: it also goes while memory stays on, when
      // the prompt has no place for it (an agent's own prompt, the person's system prompt), and the model must not then
      // be told that memory is off.
      const on = yield* store.enabled()
      // Read once too, for the guide and the team index. It is undefined until the project is trusted (class 1).
      const team = yield* teams.current()
      const guide = Instructions.make({
        key: GUIDE,
        codec: Schema.toCodecJson(Guide),
        read: Effect.gen(function* () {
          if (!input.guide || !on) return Instructions.removed
          // The guide tells the model that the folders exist, so it never spends a step making them.
          yield* ensureFolder(store.folder)
          if (team === undefined) return store.folder
          yield* ensureFolder(team.folder)
          return { folder: store.folder, team: team.folder }
        }),
        render: {
          initial: renderGuide,
          changed: (_previous, value) => renderGuide(value),
          removed: () =>
            on
              ? "The memory guide given earlier is not part of the current prompt. Memory itself is not switched off."
              : "Memory is switched off for this session: do not read or write memory files.",
        },
      })
      const memoryIndex = Instructions.make({
        key: INDEX,
        codec: Schema.toCodecJson(Index),
        read: Effect.gen(function* () {
          if (!input.index || !on) return Instructions.removed
          const kept = frozen.get(input.sessionID)
          if (kept !== undefined) return kept
          const value = yield* readIndex(index, yield* store.locate(index))
          frozen.set(input.sessionID, value)
          return value
        }),
        render: {
          initial: renderIndex,
          changed: (_previous, value) => `The memory index changed.\n\n${renderIndex(value)}`,
          removed: () => "The memory index loaded earlier no longer applies.",
        },
      })
      const teamIndex = Instructions.make({
        key: TEAM_INDEX,
        codec: Schema.toCodecJson(Index),
        read: Effect.gen(function* () {
          if (!input.index || team === undefined) return Instructions.removed
          const kept = frozenTeam.get(input.sessionID)
          if (kept !== undefined) return kept
          const file = path.join(team.folder, MemoryStore.ENTRYPOINT)
          const value = yield* readIndex(file, yield* MemoryStore.locate(fs, team.real, file))
          frozenTeam.set(input.sessionID, value)
          return value
        }),
        render: {
          initial: renderTeamIndex,
          changed: (_previous, value) => `The team memory index changed.\n\n${renderTeamIndex(value)}`,
          removed: () => "The team memory index loaded earlier no longer applies.",
        },
      })
      const agentMemory = Instructions.make({
        key: AGENT,
        codec: Schema.toCodecJson(AgentBlock),
        read: Effect.gen(function* () {
          const agent = input.agent
          if (!on || agent?.memory === undefined) return Instructions.removed
          // A session keeps the block it first read while its agent and scope stay the same.
          const kept = frozenAgent.get(input.sessionID)
          if (kept !== undefined && kept.agent === agent.id && kept.scope === agent.memory) return kept
          const resolved = yield* agents.folder(agent.id, agent.memory)
          if (resolved === undefined) return Instructions.removed
          // The block says the folder exists. What is made, and what the index is read from, is the real place that
          // `MemoryAgent` checked, while the block names the folder as it is spelled (class 3).
          yield* ensureFolder(resolved.real)
          const file = path.join(resolved.folder, MemoryStore.ENTRYPOINT)
          const value = {
            agent: agent.id,
            scope: agent.memory,
            folder: resolved.folder,
            index: yield* indexText(yield* MemoryStore.locate(fs, resolved.real, file)),
          }
          frozenAgent.set(input.sessionID, value)
          return value
        }),
        render: {
          initial: renderAgentMemory,
          changed: (_previous, value) => `The agent memory changed.\n\n${renderAgentMemory(value)}`,
          removed: () =>
            on
              ? "The agent memory given earlier no longer applies."
              : "Memory is switched off for this session, so this agent's memory is off as well: do not read or write its files.",
        },
      })
      return Instructions.combine([guide, memoryIndex, teamIndex, agentMemory])
    })

    return Service.of({ load })
  }),
)

const renderIndex = (value: Index) =>
  `Contents of ${heading(value.path)}, the person's auto-memory index. It lists the memories kept for this project in earlier conversations; each entry points to a file in the same folder:\n\n${neutralize(value.content)}`

// The tag marks where the shared text starts and ends, so a look-alike of it inside the text is escaped as well.
const renderTeamIndex = (value: Index) =>
  `Contents of ${heading(value.path)}, the team's shared memory index. It is kept in the repository and shared with everyone who works on it; each entry points to a file in the same folder:\n\n<team-memory source="repository">\n${neutralize(value.content).replace(/<(?=\s*\/?\s*team\s*-\s*memory)/gi, "&lt;")}\n</team-memory>`

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
    // A MEMORY.md that is a link of any kind is left alone, one that leads nowhere included: a write through it would
    // change or create whatever it names, wherever that is (class 4). The link is read, never followed.
    if (yield* Effect.isSuccess(fs.readLink(index))) return
    const current = (yield* fs.readFileStringSafe(index)) ?? ""
    const lines = yield* Effect.forEach(
      files.filter((file) => !current.includes(`](${file})`)),
      (file) =>
        fs
          .readFileStringSafe(path.join(target, file))
          .pipe(Effect.map((text) => `- [${file.slice(0, -3)}](${file}): ${summary(text ?? "")}`)),
    )
    if (lines.length === 0) return
    const separator = current === "" || current.endsWith("\n") ? "" : "\n"
    yield* fs.writeWithDirs(index, `${current}${separator}${lines.join("\n")}\n`)
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory notes from before trust not moved", { cause })))

function summary(text: string) {
  const line = text.split("\n").find((item) => item.trim()) ?? ""
  return line
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 150)
}

// The guide follows the reference's section order and what each section asks of the model, in Orbit's own words. With
// team memory on it is the combined guide: two folders, a section on scope, a scope line for each kind, a rule against
// secrets in team memory and an index in each folder.
const renderGuide = (value: Guide) => {
  const folder = typeof value === "string" ? value : value.folder
  const team = typeof value === "string" ? undefined : value.team
  return `# Memory

${
  team === undefined
    ? `You have a memory that lasts between conversations: a folder of Markdown files at \`${heading(folder)}\`. The folder already exists, so write to it directly with Write and Edit; do not create it or check that it is there.`
    : `You have a memory that lasts between conversations, kept in two folders of Markdown files: a private one at \`${heading(folder)}\` and a team one at \`${heading(team)}\`. Both folders already exist, so write to them directly with Write and Edit; do not create them or check that they are there.`
}

${guideBody(team)}`
}

// The block of an agent with a memory scope: the private guide under a heading of its own that names the agent's folder,
// with one line after its last section on how far the scope reaches, and then the agent's own index, as the reference
// builds it. The index is the agent's to keep, so look-alikes of the reminder envelope in it are escaped (class 9).
const renderAgentMemory = (value: AgentBlock) => `# Persistent agent memory

You have a persistent memory of your own as this agent, kept between conversations: a folder of Markdown files at \`${heading(value.folder)}\`. The folder already exists, so write to it directly with Write and Edit; do not create it or check that it is there.

${guideBody(undefined)}

${AGENT_SCOPES[value.scope]}

## ${MemoryStore.ENTRYPOINT}

${value.index === "" ? `Your ${MemoryStore.ENTRYPOINT} is empty. It fills as you save memories.` : neutralize(value.index)}`

const AGENT_SCOPES: Record<MemoryAgent.Scope, string> = {
  user: "This memory has the user scope: it goes with you into every project, so keep what you save general, true wherever you work.",
  project:
    "This memory has the project scope: it is committed with the repository and shared with the team through version control, so fit what you save to this project.",
  local:
    "This memory has the local scope: it stays in this project but is not committed to version control, so fit what you save to this project and this machine.",
}

// What the guide says after its opening paragraph, which the agent block shares. With a team folder it is the combined
// guide's.
const guideBody = (team: string | undefined) => {
  // A line that only the combined guide has, with the line break that puts it after the line before it.
  const scope = (text: string) => (team === undefined ? "" : `\n- Scope: ${text}`)
  return `Use it to build up, over time, a picture of who the person is, how they like to work, what to repeat and what to avoid, and the context of the work you do together, so that a later conversation starts where this one leaves off.

When the person asks you to remember something, save it right away. When they ask you to forget something, find it and remove it.
${
  team === undefined
    ? ""
    : `
## Private and team memory

Each memory has a scope, and the scope picks its folder.

- Private memories are between you and this person. They stay on this machine, in the private folder.
- Team memories are shared with everyone who works in this repository, and any of them may write one. They live in the team folder inside the repository and travel with it through version control, so a teammate's session reads what you save there, and yours reads what theirs saved.
`
}
## Kinds of memory

Each memory is one of four kinds.

### \`user\`
- What it holds: who the person is, their role, what they know well and what is new to them, how they like to collaborate.
- When to save: when you learn something about them that would change how you work with them.
- How to use: fit explanations, the level of detail and the choices you make to the person.${scope("always private: it is about this person, not the project.")}
- Examples:
  - person: "I'm a statistician, so the models are fine, but containers are new to me." → save a \`user\` memory: at home with statistics, new to containers; spell out the container steps and skip the statistics.
  - person: "I look after the documentation site and rarely open the server code." → save a \`user\` memory: works mostly on the docs; say more about it when a change reaches the server.

### \`feedback\`
- What it holds: guidance the person gave on how you work, both corrections and approaches they confirmed.
- When to save: when they correct you, or say that something you did was right in a way that was not obvious.
- How to use: follow it, so they never have to say it twice.
- Shape: the rule, then a line "Why:" with the reason they gave, then a line "How to apply:" with when it applies.${scope('private, unless it is a convention every contributor must follow, such as a testing policy or a build rule, rather than this person\'s own taste; then team. For example, "our tests never mock the database" said as the project\'s rule is team feedback, while "keep your answers short" is private.')}
- Examples:
  - person: "Don't call the new module \`helpers\`; we name a file after the one job it does." → save a \`feedback\` memory: name a new file after its job, never a catch-all such as \`helpers\` or \`misc\`. Why: the team finds code by its file names. How to apply: every file or module you create.
  - person: "Good call putting the schema change in its own commit." → save a \`feedback\` memory: a schema change gets a commit of its own. Why: it can be reviewed and reverted alone. How to apply: any change that alters the stored data's shape.

### \`project\`
- What it holds: facts about the work that the code and its history do not show: goals, deadlines, decisions, who is doing what and why.
- When to save: when you learn such a fact. Turn relative dates into absolute ones ("Thursday" becomes the date), so the memory still reads right later.
- How to use: understand the reasons behind a request and make suggestions that fit them.
- Shape: the fact or decision, then a line "Why:", then a line "How to apply:".${scope("either, leaning to team: a deadline or a decision about the project helps everyone who works on it, so the importer demo date goes to team memory, while a note on how this person splits their own week stays private.")}
- Examples:
  - person: "We show the importer to the pilot customers in two weeks." → save a \`project\` memory: the importer demo is on the date two weeks from today. Why: pilot customers see it then. How to apply: put importer bugs ahead of other work until that day.
  - person: "Priya owns the billing service, so ask her before changing its API." → save a \`project\` memory: Priya owns billing and approves changes to its API. How to apply: name her when a change touches that API.

### \`reference\`
- What it holds: where to find information that lives outside the project: a tracker, a dashboard, a channel, a document.
- When to save: when the person tells you where something is kept.
- How to use: look there when the question is about what it holds.${scope("usually team, since a tracker or a dashboard serves everyone on the project: the channel where customer bug reports land goes to team memory.")}
- Examples:
  - person: "Customer bug reports land in the support-escalations channel first." → save a \`reference\` memory: the first copy of a customer's bug report is in that channel.
  - person: "Our API naming rules are in the style guide linked from the wiki's home page." → save a \`reference\` memory: read that style guide before naming a new endpoint.

## What not to save

- Anything the code, the project's files or the version history already tell: structure, conventions, file locations, who changed what.
- The steps of a bug you fixed: the change records them, and its commit message gives the reason.
- Anything already in the instruction files.
- The state of the task at hand: what you are doing now and what is left belongs to this conversation only.${
    team === undefined
      ? ""
      : "\n- Never a secret in team memory: no API key, token, password or other credential. Everyone with the repository reads it, and a write there that looks like a credential is refused."
  }

This holds even when the person asks you to save such a thing. Then ask what about it was surprising or worth keeping, and save that instead.

## How to save a memory

Saving takes two steps.

1. Create one file per memory${team === undefined ? "" : ", in the folder its scope picks"}, give it a name that says its topic, and start it with this front matter:

\`\`\`markdown
---
name: <a short name>
description: <one line that says what the memory is about, used to judge later whether it is relevant>
type: <user, feedback, project or reference>
---

<the memory; for feedback and project, the rule or fact, then "Why:" and "How to apply:" lines>
\`\`\`

2. Add a line for it to \`MEMORY.md\` in the same folder: a link to the file and a few words on what it holds, under about 150 characters. \`MEMORY.md\` is an index, not a memory: it has no front matter and never holds the content of a memory.

${
  team === undefined
    ? "`MEMORY.md` is loaded into every conversation, and the part past 200 lines is cut off, so keep it short."
    : "Each folder has its own `MEMORY.md`: a team memory gets its line in the team folder's index, a private one in the private folder's. Both indexes are loaded into every conversation, and the part of each past 200 lines is cut off, so keep them short."
} Keep the name, description and type of each file current. Organise memories by topic rather than by date. Change or remove a memory that turns out to be wrong or out of date, and do not write one that repeats another: update the existing one. Use Write to create a file and Edit to change one.

## When to use memory

${
  team === undefined
    ? "- Look at your memories when they seem relevant to the task, or when the person refers to earlier work."
    : "- Look at your memories, private or team, when they seem relevant to the task, or when the person refers to earlier work, their own or that of others on the project."
}
- When the person asks you to check, recall or remember something, you must look.
- When the person tells you to ignore memory, act as if the folder were empty, and do not mention or use what it holds.
- Memories go out of date. If a memory conflicts with what you see now, trust what you see now, and fix or remove the memory.

## Before acting on a memory

Treat what a memory says about the code as true on the day it was saved, not today. When it mentions a file, a function or a setting, open the file or search for the name before you rely on it or suggest it to the person. When it describes how the repository looks, read the code and the version history instead, and go with them where they disagree.

## Memory, plans and tasks

Memory is for what a later conversation needs to know. When you and the person need to agree on how to do the work at hand, use a plan. To keep track of progress through the steps of the current work, use the task list. Neither belongs in memory.`
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    MemoryStore.node,
    MemoryTeam.node,
    MemoryAgent.node,
    FSUtil.node,
    Global.node,
    Location.node,
    Bus.node,
    InstructionDiscovery.node,
  ],
})
