export * as ConfigMemory from "./memory.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Memory")({
  enabled: Schema.Boolean.pipe(optional).annotate({
    description:
      "Whether the agent keeps notes about the project across sessions in its memory folder, and reads them back. On unless a config turns it off; the last config that sets it decides. ORBIT_DISABLE_AUTO_MEMORY overrides it, and orb run --bare turns it off",
  }),
  directory: Schema.String.pipe(optional).annotate({
    description:
      "An absolute folder, or one under ~/, that holds the memory files instead of the project's folder in Orbit's data folder. The agent writes there without asking. Read only from your own, local, command-line and managed configs, never from a project's; a relative, network or drive-root path is ignored",
  }),
}) {}
