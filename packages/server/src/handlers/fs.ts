import path from "node:path"
import { requireTrusted, requireTrustedAt } from "./trust-error"
import { FileSystem } from "@orbit/core/filesystem"
import { Location } from "@orbit/core/location"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { FileNotFoundError } from "@orbit/protocol/errors"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    const folders = { projects: yield* Project.Service, trust: yield* WorkspaceTrust.Service }
    const global = yield* Global.Service
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const file = yield* fs
            .read({
              path: RelativePath.make(
                decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
              ),
            })
            .pipe(
              Effect.mapError(
                (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
              ),
            )
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      .handle("fs.write", (ctx) =>
        response(
          Effect.gen(function* () {
            yield* requireTrusted()
            const location = yield* Location.Service
            const trust = yield* ProjectTrust.Service
            // A write can land outside the Location, through `..`, an absolute path or a link, so the folder it really
            // lands in has to be trusted as well (class 3, class 4). `leads` follows every link in the path, and one that
            // leads nowhere by where it points. Orbit's own temporary folder, where clients stage files, holds nothing a
            // repository supplies, so a write there needs no grant.
            const leads = yield* trust.leads(path.resolve(location.directory, ctx.query.path))
            if (!FSUtil.contains(yield* trust.leads(global.tmp), leads))
              yield* requireTrustedAt(folders, AbsolutePath.make(path.dirname(leads)))
            const fs = yield* FileSystem.Service
            return yield* fs.write({ path: ctx.query.path, data: ctx.payload })
          }),
        ),
      )
  }),
)

