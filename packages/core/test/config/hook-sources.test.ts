import { describe, expect, test } from "bun:test"
import { Document, Info, type Scope } from "@orbit/schema/config"
import { HookSources } from "@orbit/core/config/hook-sources"
import { Schema } from "effect"

const decode = Schema.decodeUnknownSync(Info)
const doc = (scope: Scope, hooks: unknown) => new Document({ type: "document", scope, info: decode({ hooks }) })
const own = { UserPromptSubmit: [] }

// The restriction can arrive as the organization's `managed` block or as the `hooks` block of the managed file.
describe("HookSources.collect", () => {
  const user = doc("user", own)
  const project = doc("project", own)
  for (const row of [
    { name: "nothing set", restrictions: {}, managed: own, ran: ["user", "project", "managed"] },
    { name: "disable_hooks", restrictions: { disable_hooks: true }, managed: own, ran: [] },
    { name: "managed_hooks_only", restrictions: { managed_hooks_only: true }, managed: own, ran: ["managed"] },
    { name: "managed hooks.disabled", restrictions: {}, managed: { ...own, disabled: true }, ran: [] },
    { name: "managed hooks.managed_only", restrictions: {}, managed: { ...own, managed_only: true }, ran: ["managed"] },
    {
      name: "managed hooks.disabled with managed_only",
      restrictions: {},
      managed: { ...own, disabled: true, managed_only: true },
      ran: [],
    },
    {
      name: "managed hooks.disabled false",
      restrictions: {},
      managed: { ...own, disabled: false },
      ran: ["user", "project", "managed"],
    },
  ]) {
    test(`runs ${row.ran.join(" and ") || "no"} hooks with ${row.name}`, () => {
      const entries = [user, project, doc("managed", row.managed)]
      const ran: Array<string | undefined> = HookSources.collect(entries, row.restrictions).map((entry) => entry.scope)
      expect(ran).toEqual(row.ran)
    })
  }

  test("a hooks.disabled or hooks.managed_only outside the managed scope restricts nothing here", () => {
    const entries = [doc("user", { ...own, disabled: true, managed_only: true }), doc("project", own)]
    expect(HookSources.collect(entries, {})).toHaveLength(2)
  })
})
