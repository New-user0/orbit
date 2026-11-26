import { Config } from "@orbit/core/config"
import { InstructionNotes } from "@orbit/core/instruction-notes"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { MemoryListing } from "@orbit/core/memory/listing"
import { Plugin } from "@orbit/core/plugin"
import { ProjectTrust } from "@orbit/core/project-trust"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { InvalidRequestError, ServiceUnavailableError } from "@orbit/protocol/errors"
import { AbsolutePath } from "@orbit/schema/schema"
import { Cause, Context, Effect, RcMap } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requireTrusted } from "./trust-error"

export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const workspaces = yield* WorkspaceTrust.Service
    return handlers
      .handle(
        "location.get",
        Effect.fn(function* () {
          const location = yield* Location.Service
          return new Location.Info({
            directory: location.directory,
            project: location.project,
          })
        }),
      )
      .handle("location.reload", () =>
        LocationServiceMap.reload().pipe(
          Effect.provideService(LocationServiceMap.Service, locations),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.fail(new ServiceUnavailableError({ message: Cause.pretty(cause), service: "location" })),
          ),
        ),
      )
      .handle(
        "instruction.note.targets",
        Effect.fn(function* () {
          const notes = yield* InstructionNotes.Service
          return { data: yield* notes.targets() }
        }),
      )
      .handle(
        "instruction.note.add",
        Effect.fn(function* (ctx) {
          // A note changes an instruction file, and a folder nobody trusted stays as it is (class 12).
          yield* requireTrusted()
          const notes = yield* InstructionNotes.Service
          return {
            data: yield* notes.add(ctx.payload).pipe(
              Effect.catchTags({
                "InstructionNotes.TargetError": (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, kind: error.reason, field: "scope" })),
                "InstructionNotes.WriteError": (error) =>
                  Effect.fail(new ServiceUnavailableError({ message: error.message, service: "instructions" })),
              }),
            ),
          }
        }),
      )
      .handle(
        "memory.list",
        Effect.fn(function* () {
          // The listing reads the folder's instruction files and agents, so a folder nobody trusted is refused first (class 1).
          yield* requireTrusted()
          const memory = yield* MemoryListing.Service
          return { data: yield* memory.list() }
        }),
      )
      .handle(
        "memory.ensure",
        Effect.fn(function* (ctx) {
          // Making a file or folder changes the folder, and a folder nobody trusted stays as it is (class 12).
          yield* requireTrusted()
          const memory = yield* MemoryListing.Service
          return {
            data: yield* memory.ensure(ctx.payload.target).pipe(
              Effect.catchTags({
                "MemoryListing.TargetError": (error) =>
                  Effect.fail(new InvalidRequestError({ message: error.message, kind: error.reason, field: "target" })),
                "MemoryListing.WriteError": (error) =>
                  Effect.fail(new ServiceUnavailableError({ message: error.message, service: "memory" })),
              }),
            ),
          }
        }),
      )
      .handle("location.trust.get", () => ProjectTrust.Service.use((trust) => trust.status()))
      .handle(
        "location.trust.update",
        Effect.fn(function* (ctx) {
          const trust = yield* ProjectTrust.Service
          const plugins = yield* Plugin.Service
          // The API does not know which client asked, so a grant says only that it came through here.
          const state = ctx.payload.trust
            ? yield* trust.grant({ persist: ctx.payload.persist ?? true, via: "api" })
            : yield* trust.revoke()
          // The folder's providers, agents and commands come from plugins that activate again after the config reload
          // that the grant or revoke made, so the answer waits for the plugins available locally: a client that lists
          // or acts right after it then sees the folder as it now stands (class 3). A package that still has to be
          // installed applies later and does not hold the answer.
          yield* plugins.refresh()
          return state
        }),
      )
      .handle("trust.list", () => workspaces.list())
      .handle(
        "trust.revoke",
        Effect.fn(function* (ctx) {
          // The grant is named here by folder, not by Location, so which held Locations it covered shows only by their
          // answer before and after it: those that were trusted before and are not now.
          const held = yield* Effect.forEach(
            yield* RcMap.keys(locations.rcMap),
            (ref) =>
              locations.contextEffect(ref).pipe(
                Effect.flatMap((services) =>
                  Context.get(services, ProjectTrust.Service)
                    .trusted()
                    .pipe(Effect.map((trusted) => ({ ref, trusted }))),
                ),
                Effect.scoped,
              ),
            { concurrency: "unbounded" },
          )
          const ended = yield* workspaces.forget(ctx.payload.directory)
          // A Location the server holds for a folder this left untrusted stops applying what the folder supplied before
          // the answer, as a revoke through the Location's own route does (class 3). A Location that was not trusted
          // before is left alone, so its plugins do not delay the answer.
          if (ended.length > 0)
            yield* Effect.forEach(
              held.filter((item) => item.trusted),
              (item) =>
                locations.contextEffect(item.ref).pipe(
                  Effect.flatMap((services) =>
                    Effect.gen(function* () {
                      if (yield* Context.get(services, ProjectTrust.Service).trusted()) return
                      yield* Context.get(services, Config.Service).reload?.() ?? Effect.void
                      yield* Context.get(services, Plugin.Service).refresh()
                    }),
                  ),
                  Effect.scoped,
                ),
              { discard: true, concurrency: "unbounded" },
            )
          return ended.map((item) => AbsolutePath.make(item))
        }),
      )
  }),
)
