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
import { MemoryAgentSnapshot } from "./agent-snapshot.js"
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
    const snapshots = yield* MemoryAgentSnapshot.Service
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
      // A project's snapshots of agent memory are copied before any agent block reads its folder, as the reference
      // copies them when it loads the agents. Nothing is read while memory is off.
      yield* snapshots.sync()
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

// The guide keeps the reference's section order and what each section asks of the model; every sentence is Orbit's.
// With team memory on it is the combined guide: two folders, a section on scope, a scope line for each kind, a rule
// against secrets in team memory and an index in each folder.
const renderGuide = (value: Guide) => {
  const folder = typeof value === "string" ? value : value.folder
  const team = typeof value === "string" ? undefined : value.team
  return `# Memory

${
  team === undefined
    ? `What you learn here can outlast this conversation if you write it into \`${heading(folder)}\`, a folder of Markdown files that later conversations read. The folder is already there: save into it with Write and Edit straight away, without making it first or looking to see whether it exists.`
    : `What you learn here can outlast this conversation if you write it into one of two folders of Markdown files that later conversations read: \`${heading(folder)}\`, which is private, and \`${heading(team)}\`, which the team shares. Both folders are already there: save into them with Write and Edit straight away, without making them first or looking to see whether they exist.`
}

${guideBody(team)}`
}

// The block of an agent with a memory scope: the private guide under a heading of its own that names the agent's folder,
// with one line after its last section on how far the scope reaches, and then the agent's own index, as the reference
// builds it. The index is the agent's to keep, so look-alikes of the reminder envelope in it are escaped (class 9).
const renderAgentMemory = (value: AgentBlock) => `# Your agent memory

As this agent you keep notes of your own that outlast each conversation, as Markdown files in \`${heading(value.folder)}\`. The folder is already there: save into it with Write and Edit straight away, without making it first or looking to see whether it exists.

${guideBody(undefined)}

${AGENT_SCOPES[value.scope]}

## ${MemoryStore.ENTRYPOINT}

${value.index === "" ? `Your ${MemoryStore.ENTRYPOINT} is empty. It fills as you save memories.` : neutralize(value.index)}`

const AGENT_SCOPES: Record<MemoryAgent.Scope, string> = {
  user: "Scope of these notes: user. You carry them into every project you work in, so write down only what holds in general, wherever you are.",
  project:
    "Scope of these notes: project. They are committed to the repository, which means they are shared with the team through version control; write down what holds for this project.",
  local:
    "Scope of these notes: local. They belong to this project on this machine and are not committed to version control; write down what holds for this project here.",
}

// What the guide says after its opening paragraph, which the agent block shares. With a team folder it is the combined
// guide's.
const guideBody = (team: string | undefined) => {
  // A line that only the combined guide has, with the line break that puts it after the line before it.
  const scope = (text: string) => (team === undefined ? "" : `\n- Scope: ${text}`)
  return `Memory is how you get better at working with this person from one conversation to the next. Note their background and habits, the ways of working they want you to keep or drop, and the circumstances of the project, so that a new conversation does not start from nothing.

If the person asks you to remember something, write it down at once; if they ask you to forget something, find the memory and delete it.
${
  team === undefined
    ? ""
    : `
## Two folders

Where a memory is saved depends on who it is for.

- A private memory concerns only you and this person. It goes in the private folder and never leaves this machine.
- A team memory is for everybody who works in this repository, and any of them can add one. The team folder sits inside the repository and moves with it through version control, so what you save there reaches your teammates' sessions, and what they saved reaches yours.
`
}
## What a memory can be about

There are four kinds, and every memory belongs to one of them.

### \`user\`
- Covers: the person themselves: their job, where their expertise is deep or thin, and the way they like to work with you.
- Save it: once you find out something about them that ought to change how you work together.
- Use it: to pitch explanations, depth and choices at the right level for them.${scope("always private, because it describes the person, not the project.")}
- Examples:
  - person: "I'm a statistician, so the models are fine, but containers are new to me." → save a \`user\` memory: at home with statistics, new to containers; spell out the container steps and skip the statistics.
  - person: "I look after the documentation site and rarely open the server code." → save a \`user\` memory: works mostly on the docs; say more about it when a change reaches the server.

### \`feedback\`
- Covers: what the person has told you about the way you work, whether it corrects you or confirms an approach.
- Save it: whenever they correct you, and whenever they approve of something you did that you could not have known they would want.
- Use it: act on it, so that they never need to say it again.
- Format: the rule first, then a "Reason:" line with the reason they gave and an "Applies when:" line that says where it holds.${scope('private by default. It is team feedback only when it is a rule for everyone who contributes, such as a testing policy or a build convention, rather than a matter of this person\'s taste: "our tests never mock the database", stated as how the project works, is team feedback, while "keep your answers short" is private.')}
- Examples:
  - person: "Don't call the new module \`helpers\`; we name a file after the one job it does." → save a \`feedback\` memory: name a new file after its job, never a catch-all such as \`helpers\` or \`misc\`. Reason: the team finds code by its file names. Applies when: you create any file or module.
  - person: "Good call putting the schema change in its own commit." → save a \`feedback\` memory: a schema change gets a commit of its own. Reason: it can be reviewed and reverted alone. Applies when: a change alters the shape of stored data.

### \`project\`
- Covers: what is going on in the work that neither the code nor its history records, such as goals, deadlines, decisions, and who is responsible for what and why.
- Save it: when you come across such a fact. Write any date as a calendar date ("next Friday" becomes the actual day), since a relative date stops making sense later.
- Use it: to see why a request was made and to suggest things that fit.
- Format: the fact or decision, then a "Reason:" line and an "Applies when:" line.${scope("either, but usually team: a deadline or a project decision matters to everyone on it, so the date of the importer demo is a team memory, while how this person plans their own week stays private.")}
- Examples:
  - person: "We show the importer to the pilot customers in two weeks." → save a \`project\` memory: the importer demo is on the date two weeks from today. Reason: pilot customers see it then. Applies when: choosing what to work on before that day; importer bugs come first.
  - person: "Priya owns the billing service, so ask her before changing its API." → save a \`project\` memory: Priya owns billing and approves changes to its API. Applies when: a change touches that API; name her.

### \`reference\`
- Covers: pointers to information kept outside the project, in a tracker, a dashboard, a chat channel or a document.
- Save it: when the person says where something lives.
- Use it: go to that place when a question concerns what it holds.${scope("usually team, because a tracker or a dashboard is there for the whole project: the channel that receives customer bug reports is a team memory.")}
- Examples:
  - person: "Customer bug reports land in the support-escalations channel first." → save a \`reference\` memory: the first copy of a customer's bug report is in that channel.
  - person: "Our API naming rules are in the style guide linked from the wiki's home page." → save a \`reference\` memory: read that style guide before naming a new endpoint.

## Leave these out

- Facts you can recover by reading the code, the project's files or its version history, for example how it is laid out, its conventions, where a file lives or who changed a line.
- How you fixed a bug. The fix is in the change itself, and its commit message explains it.
- Whatever the instruction files already say.
- Where the current task stands. Progress and remaining steps matter to this conversation and to no later one.${
    team === undefined
      ? ""
      : "\n- Secrets of any kind in team memory, such as API keys, tokens or passwords. Everyone with the repository can read that folder, and a write to it that looks like a credential is refused."
  }

The person asking you to save one of these does not change that. Instead, ask them which part of it surprised them or is worth carrying forward, and save that part.

## Writing a memory down

A memory takes two writes.

1. Write the memory as a file of its own${team === undefined ? "" : " in the folder that its scope selects"}, named after its topic and opening with this front matter:

\`\`\`markdown
---
name: <a short name>
description: <a line on what the memory covers, so a later conversation can tell whether it matters>
type: <user, feedback, project or reference>
---

<the memory itself; a feedback or project memory gives the rule or fact, then its "Reason:" and "Applies when:" lines>
\`\`\`

2. Add an entry for it to \`MEMORY.md\` in that folder: a link to the file and a few words on its content, under about 150 characters. \`MEMORY.md\` only lists memories and never contains one, so it has no front matter and holds no memory text.

${
  team === undefined
    ? "Every conversation loads `MEMORY.md`, and anything after line 200 is dropped, so keep it brief."
    : "Every folder keeps a `MEMORY.md` of its own: list a team memory in the team folder's index and a private memory in the private folder's. Every conversation loads both indexes, and anything after line 200 of either is dropped, so keep them brief."
} Keep each file's name, description and type accurate. Group memories by subject, not by when you wrote them. When a memory proves wrong or stale, correct it or delete it, and rather than writing a second memory on the same point, update the first. Write creates a file; Edit changes one.

## Reading memory

${
  team === undefined
    ? "- Open your memories when they look relevant to the task at hand, or when the person mentions earlier work."
    : "- Open your memories, private and team alike, when they look relevant to the task at hand, or when the person mentions earlier work, whether theirs or a colleague's."
}
- If the person asks you to check something, recall it or remember it, looking at memory is not optional.
- If the person says to ignore memory, behave as though the folder had nothing in it, and neither mention nor use its contents.
- A memory can fall behind. Where it disagrees with what you observe now, believe what you observe, and correct or delete the memory.

## Check before you trust it

What a memory says about the code was true when it was written and may not be now. Before you depend on a file, a function or a setting that a memory names, or point the person to it, open the file or search for the name. For how the repository is put together, the code and its version history are the authority, and they win over a memory that disagrees.

## What memory is not for

Memory holds what a future conversation will need. Agreeing with the person on how to approach the current work is a job for a plan, and following your progress through its steps is a job for the task list; keep both out of memory.`
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    MemoryStore.node,
    MemoryTeam.node,
    MemoryAgent.node,
    MemoryAgentSnapshot.node,
    FSUtil.node,
    Global.node,
    Location.node,
    Bus.node,
    InstructionDiscovery.node,
  ],
})
