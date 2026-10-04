export * as ConfigCompatibility from "./compatibility.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Compatibility")({
  enabled: Schema.Boolean.pipe(optional).annotate({
    description:
      "Read other agent products' settings, skills, output styles and instruction files (default: true). Only your own config, ORBIT_CONFIG or ORBIT_CONFIG_CONTENT, and organization-managed settings can change this; a repository's files cannot.",
  }),
}) {}
