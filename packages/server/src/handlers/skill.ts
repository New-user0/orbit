import { Skill } from "@orbit/core/skill"
import { Plugin } from "@orbit/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  // Like the agents, the plugins fill these in, so a Location that was just built lists them once they are active.
  handlers.handle("skill.list", () =>
    Plugin.awaitActivation.pipe(Effect.andThen(response(Skill.Service.use((skill) => skill.list())))),
  ),
)
