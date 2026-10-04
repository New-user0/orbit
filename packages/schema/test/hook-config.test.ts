import { describe, expect, test } from "bun:test"
import { HookConfig } from "../src/config/hook-config.js"

const command = (text: string) => ({ type: "command", command: text })

describe("HookConfig.decode", () => {
  test("keeps every hook that can be read, and reports each one that cannot at its path", () => {
    const result = HookConfig.decode({
      PreToolUse: [{ matcher: "shell", hooks: [command("./guard.sh"), { type: "command" }, command("./audit.sh")] }],
      // A model needs a provider that this entry does not name, and the group stays so the event still has it.
      SubagentStop: [{ hooks: [{ type: "prompt", prompt: "Did it finish?", model: 42 }] }],
    })

    expect(result.hooks).toEqual({
      PreToolUse: [{ matcher: "shell", hooks: [command("./guard.sh"), command("./audit.sh")] }],
      SubagentStop: [{ hooks: [] }],
    })
    expect(result.diagnostics).toEqual([
      {
        kind: "invalid",
        path: ["hooks", "PreToolUse", "0", "hooks", "1"],
        message: "skipped malformed recognized value",
      },
      {
        kind: "invalid",
        path: ["hooks", "SubagentStop", "0", "hooks", "0"],
        message: "skipped malformed recognized value",
      },
    ])
  })

  test("drops a key that no field names and keeps the entry, reporting the key as unsupported", () => {
    const result = HookConfig.decode({
      PreToolUse: [{ matchers: "shell", matcher: "read", hooks: [{ ...command("./guard.sh"), blocking: true }] }],
    })

    expect(result.hooks).toEqual({ PreToolUse: [{ matcher: "read", hooks: [command("./guard.sh")] }] })
    expect(result.diagnostics).toEqual([
      { kind: "unsupported", path: ["hooks", "PreToolUse", "0", "matchers"], message: "omitted unknown field" },
      {
        kind: "unsupported",
        path: ["hooks", "PreToolUse", "0", "hooks", "0", "blocking"],
        message: "omitted unknown field",
      },
    ])
  })

  test("reports an event it does not know as unsupported, and a value that is not an object as invalid", () => {
    expect(HookConfig.decode({ NotAnEvent: [], PostToolUse: [{ hooks: [command("./audit.sh")] }] })).toEqual({
      hooks: { PostToolUse: [{ hooks: [command("./audit.sh")] }] },
      diagnostics: [{ kind: "unsupported", path: ["hooks", "NotAnEvent"], message: "omitted unknown hook event" }],
    })
    for (const value of ["off", 3, null, ["PreToolUse"]])
      expect(HookConfig.decode(value)).toEqual({
        hooks: undefined,
        diagnostics: [{ kind: "invalid", path: ["hooks"], message: "skipped malformed recognized value" }],
      })
  })

  test("reads the policy keys beside the events, each on its own", () => {
    const result = HookConfig.decode({
      disabled: true,
      managed_only: "yes",
      http: { allowed_urls: ["https://hooks.example.com/*"], allowed_env_vars: "TOKEN" },
    })

    expect(result.hooks).toEqual({ disabled: true, http: { allowed_urls: ["https://hooks.example.com/*"] } })
    expect(result.diagnostics.map((diagnostic) => diagnostic.path.join("."))).toEqual([
      "hooks.managed_only",
      "hooks.http.allowed_env_vars",
    ])
  })
})
