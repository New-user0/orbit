import { Plugin } from "@orbit/core/plugin"
import { Reference } from "@orbit/core/reference"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

// Plugins add references while the Location's plugins activate, which the first request to a Location starts.
export const ReferenceHandler = HttpApiBuilder.group(Api, "server.reference", (handlers) =>
  handlers.handle("reference.list", () =>
    Plugin.awaitActivation.pipe(Effect.andThen(response(Reference.Service.use((reference) => reference.list())))),
  ),
)
