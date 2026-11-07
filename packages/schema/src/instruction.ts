export * as Instruction from "./instruction.js"

import { Schema } from "effect"

export const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/)).pipe(
  Schema.brand("Instruction.Key"),
)
export type Key = typeof Key.Type

export const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(Schema.brand("Instruction.Hash"))
export type Hash = typeof Hash.Type

export const Values = Schema.Record(Key, Hash)
export type Values = Readonly<Record<string, Hash>>

export const Removed = Schema.Literal("removed")
export type Removed = typeof Removed.Type
export const removed = Removed.make("removed")

export const Delta = Schema.Record(Schema.String, Schema.Union([Hash, Removed]))
export type Delta = typeof Delta.Type

/** Where an instruction file comes from. An import has the scope of the file that imported it. */
export const FileKind = Schema.Literals(["managed", "user", "project", "local"])
export type FileKind = typeof FileKind.Type

export class StatusFile extends Schema.Class<StatusFile>("Instruction.StatusFile")({
  /** The real path, spelled as the baseline's "Instructions from" line spells it. */
  path: Schema.String,
  kind: FileKind,
  /** The length of the text the model reads, in characters as a string counts them. */
  chars: Schema.Int,
  /** The file that imported this one. Unset for a file found on its own. */
  importedBy: Schema.optional(Schema.String),
  /** The globs a conditional rule applies to. */
  paths: Schema.optional(Schema.Array(Schema.String)),
}) {}

export const WarningType = Schema.Literals(["size", "import-untrusted", "import-external", "outside"])
export type WarningType = typeof WarningType.Type

/** Something a person should know about a loaded file. Warnings never reach the model. */
export class StatusWarning extends Schema.Class<StatusWarning>("Instruction.StatusWarning")({
  path: Schema.String,
  type: WarningType,
  message: Schema.String,
  /** For `size`: the length of the file and the limit. */
  chars: Schema.optional(Schema.Int),
  limit: Schema.optional(Schema.Int),
  /** For an import warning: the real path the import leads to, which was not opened. */
  target: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
}) {}

/** The instruction files a session's location has loaded, in the order the model reads them. */
export class Status extends Schema.Class<Status>("Instruction.Status")({
  files: Schema.Array(StatusFile),
  warnings: Schema.Array(StatusWarning),
  /** False when a source could not be read, so the list is incomplete. */
  available: Schema.Boolean,
}) {}

/** Whose instruction file a note is added to: the person's own, the project's shared one, or the person's private one for the project. */
export const NoteScope = Schema.Literals(["user", "project", "local"])
export type NoteScope = typeof NoteScope.Type

/** The most characters one note may hold, after it is trimmed. */
export const NOTE_LIMIT = 2_000

/** Why a note was refused. Nothing is created or changed for any of them. */
export const NoteRefusal = Schema.Literals(["disabled", "unavailable", "excluded", "outside"])
export type NoteRefusal = typeof NoteRefusal.Type

/** The file a note for one scope would be added to. */
export class NoteTarget extends Schema.Class<NoteTarget>("Instruction.NoteTarget")({
  scope: NoteScope,
  /** The file the note would land in. When it does not exist yet, this is the file that would be created. */
  path: Schema.String,
  exists: Schema.Boolean,
  /** False when this scope's instruction files are not loaded in this location, so a note would be refused. */
  enabled: Schema.Boolean,
  /** Whether the file is among the loaded instruction files right now. */
  loaded: Schema.Boolean,
}) {}

/** The outcome of adding a note. */
export class NoteAdded extends Schema.Class<NoteAdded>("Instruction.NoteAdded")({
  scope: NoteScope,
  path: Schema.String,
  /** True when the note created the file. */
  created: Schema.Boolean,
  /** Whether the file is among the loaded instruction files after the note. False when a setting excludes it. */
  loaded: Schema.Boolean,
}) {}

/**
 * What `/memory` asks the server to make. It names a row of the listing, never a place: the server finds the place again
 * from what it lists now, so a name or path a client sends is never joined into one.
 */
export const MemoryTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("file"),
    /** A loaded instruction file, exactly as the listing spells it. */
    path: Schema.String,
  }).annotate({ identifier: "Instruction.MemoryTarget.File" }),
  Schema.Struct({ type: Schema.Literal("scope"), scope: NoteScope }).annotate({
    identifier: "Instruction.MemoryTarget.Scope",
  }),
  Schema.Struct({ type: Schema.Literal("memory") }).annotate({ identifier: "Instruction.MemoryTarget.Memory" }),
  Schema.Struct({ type: Schema.Literal("team") }).annotate({ identifier: "Instruction.MemoryTarget.Team" }),
  Schema.Struct({ type: Schema.Literal("agent"), agent: Schema.String }).annotate({
    identifier: "Instruction.MemoryTarget.Agent",
  }),
]).annotate({ identifier: "Instruction.MemoryTarget" })
export type MemoryTarget = typeof MemoryTarget.Type

/** Why a memory target was refused. Nothing is created for any of them. */
export const MemoryRefusal = Schema.Literals(["unknown", "refused", "disabled", "unavailable", "excluded", "outside"])
export type MemoryRefusal = typeof MemoryRefusal.Type

/** A row of `/memory` for an instruction file: one that loaded, or the user or project file a person can create. */
export class MemoryFile extends Schema.Class<MemoryFile>("Instruction.MemoryFile")({
  path: Schema.String,
  kind: FileKind,
  /** The length of the text the model reads; 0 for a file that is not loaded. */
  chars: Schema.Int,
  importedBy: Schema.optional(Schema.String),
  /** Set on the file a note for the user or project scope goes to, loaded or not. */
  role: Schema.optional(Schema.Literals(["user", "project"])),
  exists: Schema.Boolean,
  target: MemoryTarget,
}) {}

/** A row of `/memory` for a memory folder. `path` is the folder as it is spelled; `ensure` answers where it really is. */
export class MemoryFolder extends Schema.Class<MemoryFolder>("Instruction.MemoryFolder")({
  type: Schema.Literals(["memory", "team", "agent"]),
  agent: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Literals(["user", "project", "local"])),
  path: Schema.String,
  exists: Schema.Boolean,
  target: MemoryTarget,
}) {}

/** What `/memory` shows for a location. */
export class MemoryListing extends Schema.Class<MemoryListing>("Instruction.MemoryListing")({
  files: Schema.Array(MemoryFile),
  warnings: Schema.Array(StatusWarning),
  /** Empty while memory is off. */
  folders: Schema.Array(MemoryFolder),
  /** Whether memory is on now. */
  enabled: Schema.Boolean,
  /** Whether the project is a git repository, so its file is checked in. */
  git: Schema.Boolean,
  /** False when a source of instruction files could not be read, so the list is incomplete. */
  available: Schema.Boolean,
}) {}

/** The place a memory target is at, made when it was not there. */
export class MemoryEnsured extends Schema.Class<MemoryEnsured>("Instruction.MemoryEnsured")({
  /** Where the file or folder really is, which is what a client opens. */
  path: Schema.String,
  created: Schema.Boolean,
  type: Schema.Literals(["file", "folder"]),
}) {}
