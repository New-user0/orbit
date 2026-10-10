export * as ConfigWebFetch from "./webfetch.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.WebFetch")({
  verbatim_hosts: Schema.String.pipe(Schema.Array, optional).annotate({
    description:
      'Hosts whose pages WebFetch returns whole instead of answering from them. Each entry is a host pattern with an optional path prefix, such as "docs.example.com", "*.example.com" or "example.com/guides". Only a Markdown page under 100,000 characters qualifies; any other page is answered by the small model. Write a non-ASCII host in its ASCII form and an IPv6 address in brackets. The default is none, and listing a host grants no permission to fetch it.',
  }),
}) {}
