export * as ConfigAttribution from "./attribution.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Attribution")({
  commit: Schema.String.pipe(optional).annotate({
    description:
      'Text the agent ends every commit message it writes with, after a blank line. It may hold several lines, such as several trailers. Unset uses "Assisted-by: Orbit"; an empty string adds no attribution to commits.',
  }),
  pr: Schema.String.pipe(optional).annotate({
    description:
      'Text the agent ends every pull request description it writes with. Unset uses "Created with Orbit"; an empty string adds no attribution to pull requests.',
  }),
}) {}
