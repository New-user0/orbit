import { describe, expect, test } from "bun:test"
import { ConfigNormalize } from "@orbit/core/config/normalize"

// An entry of the legacy `agent` and `mode` maps is judged field by field: a typo in one field costs that field, never
// the deny rules written beside it, and a model written with the legacy `variant` field keeps both.
function agents(input: unknown) {
  const result = ConfigNormalize.normalize(input)
  if (result.type !== "normalized") throw new Error("rejected")
  return {
    agents: (result.encoded as { agents?: Record<string, Record<string, any>> }).agents ?? {},
    paths: result.diagnostics.map((item) => item.path.join(".")),
  }
}

describe("legacy agent and mode entries", () => {
  const bad: Record<string, unknown> = {
    color: "red",
    temperature: "0.5",
    steps: 0,
    mode: "sub",
    description: 5,
    options: "x",
    hidden: "yes",
    prompt: 5,
  }
  for (const door of ["agent", "mode"] as const)
    for (const [field, value] of Object.entries(bad))
      test(`${door}: a bad ${field} keeps the deny beside it and is named`, () => {
        const result = agents({ [door]: { build: { [field]: value, permission: { bash: "deny" } } } })
        expect(JSON.stringify(result.agents.build?.permissions)).toContain("deny")
        expect(result.paths).toContain(`${door}.build.${field}`)
      })

  // The per-entry notes of the tools map and the permission object are reported at the entry's own path.
  const notes = [
    { name: "a tool that is not a boolean", entry: { tools: { edit: "maybe" } }, path: "tools.edit" },
    { name: "a permission that is not an action", entry: { permission: { bash: "maybe" } }, path: "permission.bash" },
    {
      name: "a pattern that is not an action",
      entry: { permission: { bash: { "rm *": "maybe" } } },
      path: "permission.bash.rm *",
    },
  ]
  for (const door of ["agent", "mode"] as const)
    for (const row of notes)
      test(`${door}: ${row.name} is named at its own path`, () => {
        expect(agents({ [door]: { plan: row.entry } }).paths).toEqual([`${door}.plan.${row.path}`])
      })

  for (const door of ["agent", "mode"] as const) {
    test(`${door}: a provider model keeps its variant`, () => {
      expect(agents({ [door]: { build: { model: "acme/model-1", variant: "high" } } }).agents.build?.model).toEqual({
        providerID: "acme",
        model: "model-1",
        variant: "high",
      })
    })
    test(`${door}: a tier takes no variant and sends no effort`, () => {
      const result = agents({ [door]: { build: { model: "small", variant: "high" } } })
      expect(JSON.stringify(result.agents.build?.request ?? {})).not.toContain("effort")
      expect(result.paths).toContain(`${door}.build.variant`)
    })
  }

  // Every key Orbit's own schema has, beside the v1 keys, is read natively in these maps: a `permissions` deny holds, a
  // bad rule is named at its own path and no native key reaches the request body.
  for (const door of ["agent", "mode"] as const)
    for (const tools of [undefined, { webfetch: false }]) {
      const label = `${door}${tools ? " with a tools map" : ""}`
      const entry = (extra: Record<string, unknown>) => ({
        [door]: { build: { ...(tools ? { tools } : {}), ...extra } },
      })
      test(`${label}: a native permissions deny survives and a bad rule is named`, () => {
        const deny = { action: "Read", resource: "*.env", effect: "deny" }
        const result = agents(entry({ permissions: [deny, { action: "Bash", resource: "x", effect: "Deny" }] }))
        expect(result.agents.build?.permissions).toContainEqual(deny)
        expect(result.paths).toEqual([`${door}.build.permissions.1`])
      })
      test(`${label}: disallowed_tools lands on the agent and no native key reaches the request body`, () => {
        const result = agents(
          entry({ disallowed_tools: ["Bash"], permission_mode: "plan", max_turns: 3, initial_prompt: "hi" }),
        )
        expect(result.agents.build?.disallowed_tools).toEqual(["Bash"])
        expect(result.agents.build?.permission_mode).toBe("plan")
        expect(result.agents.build?.request?.body ?? {}).toEqual({})
        expect(result.paths).toEqual([])
      })
    }

  // A door whose value is not a map is named as a whole instead of vanishing.
  for (const door of ["agent", "mode"] as const)
    for (const value of ["x", [], null, 5])
      test(`${door}: a value of ${JSON.stringify(value)} is named at the door`, () => {
        const result = agents({ [door]: value })
        expect(result.paths).toEqual([door])
        expect(result.agents).toEqual({})
      })
  test("an absent door reports nothing", () => {
    expect(agents({}).paths).toEqual([])
  })
})
