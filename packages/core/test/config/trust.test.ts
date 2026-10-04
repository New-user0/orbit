import path from "path"
import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@orbit/core/config"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Directory, Document, Info, type Entry, type Scope } from "@orbit/schema/config"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { ConfigCommand } from "@orbit/schema/config/command"
import { Trust } from "@orbit/schema/trust"

const decode = Schema.decodeUnknownSync(Info)
const sanitize = (input: unknown) => ConfigTrust.sanitize(decode(input))

describe("ConfigTrust classification", () => {
  test("covers every field of Config.Info, Config.Agent and Config.Command", () => {
    expect(Object.keys(ConfigTrust.classification.info).toSorted()).toEqual(Object.keys(Info.fields).toSorted())
    expect(Object.keys(ConfigTrust.classification.agent).toSorted()).toEqual(
      Object.keys(ConfigAgent.Info.fields).toSorted(),
    )
    expect(Object.keys(ConfigTrust.classification.command).toSorted()).toEqual(
      Object.keys(ConfigCommand.Info.fields).toSorted(),
    )
  })

  test("names only kinds that exist", () => {
    const tables = [
      ...Object.values(ConfigTrust.classification.info),
      ...Object.values(ConfigTrust.classification.agent),
      ...Object.values(ConfigTrust.classification.command),
    ]
    for (const treatment of tables) {
      if (treatment.type === "withhold" || treatment.type === "flag") expect(Trust.Kinds).toContain(treatment.kind)
    }
  })
})

describe("ConfigTrust.sanitize", () => {
  // One sample of every field that is withheld whole, with the kind it is reported under.
  const withheldWhole: ReadonlyArray<readonly [string, unknown, Trust.Kind]> = [
    ["shell", "/bin/zsh", "shell"],
    ["update", "auto", "network"],
    ["share", "auto", "network"],
    ["enterprise", { url: "https://share.example.com" }, "network"],
    ["hooks", { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] }, "hooks"],
    ["mcp", { servers: { docs: { type: "local", command: ["docs-server"] } } }, "mcp"],
    ["plugins", ["acme-plugin"], "plugins"],
    ["providers", { custom: { name: "Custom" } }, "providers"],
    ["sandbox", { enabled: false }, "sandbox"],
    ["formatter", { prettier: { disabled: true } }, "formatter"],
    ["lsp", { gopls: { command: ["gopls"] } }, "lsp"],
    ["skills", ["./skills"], "settings"],
    ["references", { docs: "https://example.com/docs.git" }, "settings"],
    ["worktree", { directory: "../worktrees" }, "settings"],
    ["experimental", { subagent_depth: 4 }, "settings"],
  ]

  test.each(withheldWhole)("withholds %p whole and reports it as %p", (field, value, kind) => {
    const result = sanitize({ model: "acme/fast", [field]: value })
    expect(result.info).not.toHaveProperty(field)
    expect<unknown>(result.info.model).toEqual({ providerID: "acme", model: "fast" })
    expect(result.withheld).toEqual([kind])
  })

  // The value is withheld whatever it holds: Config.latest takes the highest-ranked value that is set, so an empty one
  // would still mask what the user set.
  test.each([
    ["sandbox", {}],
    ["sandbox", { enabled: true }],
    ["formatter", true],
    ["formatter", false],
    ["formatter", {}],
    ["lsp", true],
    ["lsp", false],
    ["hooks", {}],
    ["mcp", {}],
    ["plugins", []],
    ["providers", {}],
    ["experimental", {}],
    ["experimental", { portable_shell_scanner: false }],
    ["skills", []],
    ["references", {}],
  ] as const)("withholds %p even as %p", (field, value) => {
    const result = sanitize({ [field]: value })
    expect(result.info[field]).toBeUndefined()
    expect(result.withheld).toHaveLength(1)
  })

  test("keeps the fields that cannot run code, spend money or reach the network", () => {
    const inert = decode({
      $schema: "https://example.com/orbit.json",
      model: "acme/fast#high",
      default_agent: "build",
      output_style: "explanatory",
      username: "dev",
      snapshots: false,
      watcher: { ignore: ["dist"] },
      media: { image: { auto_resize: false } },
      tool_output: { max_lines: 100 },
      compaction: { auto: false, buffer: 100 },
      compatibility: { enabled: true },
      warming: false,
      websearch: false,
      permissions: [{ action: "shell", resource: "rm *", effect: "deny" }],
      instructions: ["./docs/ARCHITECTURE.md"],
      commands: { review: { template: "Review $ARGUMENTS", description: "Review a change" } },
      agents: { reviewer: { system: "Review carefully.", model: "acme/fast", steps: 5, mode: "subagent" } },
    })
    const result = ConfigTrust.sanitize(inert)
    // Nothing was taken out, so nothing was copied.
    expect(result.info).toBe(inert)
    expect(result.withheld).toEqual([])
  })

  test("keeps only the deny rules of permissions", () => {
    const deny = { action: "shell", resource: "rm *", effect: "deny" } as const
    const later = { action: "edit", resource: "secrets/**", effect: "deny" } as const
    const result = sanitize({
      permissions: [
        { action: "shell", resource: "*", effect: "allow" },
        deny,
        { action: "edit", resource: "**", effect: "ask" },
        later,
      ],
    })
    expect(result.info.permissions).toEqual([deny, later])
    expect(result.withheld).toEqual(["permissions"])

    const allowOnly = sanitize({ permissions: [{ action: "shell", resource: "*", effect: "allow" }] })
    expect(allowOnly.info).not.toHaveProperty("permissions")
    expect(allowOnly.withheld).toEqual(["permissions"])

    const denyOnly = decode({ permissions: [deny] })
    expect(ConfigTrust.sanitize(denyOnly)).toEqual({ info: denyOnly, withheld: [] })
    expect(ConfigTrust.sanitize(denyOnly).info).toBe(denyOnly)
  })

  test("drops the request and the allow and ask rules of agents, and keeps the rest", () => {
    const deny = { action: "edit", resource: "**", effect: "deny" } as const
    const result = sanitize({
      agents: {
        reviewer: {
          system: "Review carefully.",
          model: "acme/fast",
          steps: 5,
          request: { headers: { "x-extra": "1" } },
          permissions: [{ action: "shell", resource: "*", effect: "allow" }, deny],
        },
        plain: { description: "No request and no rules" },
        asker: { request: { body: { tools: [] } }, permissions: [{ action: "shell", resource: "*", effect: "ask" }] },
      },
    })
    const agents = result.info.agents
    expect(agents?.reviewer).toBeInstanceOf(ConfigAgent.Info)
    expect(agents?.reviewer).toMatchObject({ system: "Review carefully.", steps: 5, permissions: [deny] })
    expect(agents?.reviewer).not.toHaveProperty("request")
    expect(agents?.asker).toEqual(new ConfigAgent.Info({}))
    expect(agents?.plain).toEqual(new ConfigAgent.Info({ description: "No request and no rules" }))
    // The kinds follow Trust.Kinds, not the order in which the document met them.
    expect(result.withheld).toEqual(["permissions", "providers"])
  })

  test("keeps an agent whose request and rules are already harmless as it was", () => {
    const original = decode({ agents: { reviewer: { system: "Review.", permissions: [] }, build: { disabled: true } } })
    const result = ConfigTrust.sanitize(original)
    expect(result.info).toBe(original)
    expect(result.info.agents?.reviewer).toBe(original.agents?.reviewer)
    expect(result.withheld).toEqual([])
  })

  test("drops instruction URLs of every scheme and keeps instruction paths", () => {
    const paths = [
      "./docs/ARCHITECTURE.md",
      "../shared/rules.md",
      "/abs/rules.md",
      "~/notes.md",
      "C:\\notes\\rules.md",
      "C:/notes/rules.md",
      "docs/http-notes.md",
    ]
    const result = sanitize({
      instructions: [
        "https://example.com/rules.md",
        paths[0],
        "http://example.com/rules.md",
        paths[1],
        "HTTPS://EXAMPLE.COM/RULES.MD",
        "file:///etc/hosts",
        ...paths.slice(2),
      ],
    })
    expect(result.info.instructions).toEqual(paths)
    expect(result.withheld).toEqual(["network"])

    const onlyUrls = sanitize({ instructions: ["https://example.com/rules.md"] })
    expect(onlyUrls.info).not.toHaveProperty("instructions")
    expect(onlyUrls.withheld).toEqual(["network"])
  })

  test("keeps web search off and withholds every provider selection", () => {
    for (const selection of [{ provider: "random" }, { provider: "exa" }]) {
      const result = sanitize({ websearch: selection, model: "acme/fast" })
      expect(result.info).not.toHaveProperty("websearch")
      expect(result.withheld).toEqual(["network"])
    }
    const off = decode({ websearch: false })
    expect(ConfigTrust.sanitize(off)).toEqual({ info: off, withheld: [] })
    expect(ConfigTrust.sanitize(off).info.websearch).toBe(false)
  })

  test("flags commands that run a shell snippet and keeps every command", () => {
    const plain = decode({ commands: { review: { template: "Review $ARGUMENTS. Say `hello` and !not-a-snippet" } } })
    expect(ConfigTrust.sanitize(plain)).toEqual({ info: plain, withheld: [] })

    const flagged = decode({
      commands: {
        review: { template: "Review $ARGUMENTS" },
        branch: { template: "The branch is !`git branch --show-current`." },
      },
    })
    const result = ConfigTrust.sanitize(flagged)
    expect(result.withheld).toEqual(["commands"])
    expect(result.info).toBe(flagged)
    expect(Object.keys(result.info.commands ?? {})).toEqual(["review", "branch"])
  })

  test("reports each kind once, in the order of Trust.Kinds", () => {
    const result = sanitize({
      share: "auto",
      mcp: { servers: {} },
      permissions: [{ action: "shell", resource: "*", effect: "allow" }],
      hooks: {},
      update: "notify",
      sandbox: {},
      commands: { a: { template: "!`one`" }, b: { template: "!`two`" } },
      skills: ["./a"],
      plugins: [],
      instructions: ["https://example.com/a.md"],
    })
    expect(result.withheld).toEqual([
      "hooks",
      "mcp",
      "plugins",
      "commands",
      "permissions",
      "sandbox",
      "network",
      "settings",
    ])
    expect(result.withheld.map((kind) => Trust.Kinds.indexOf(kind))).toEqual(
      result.withheld.map((kind) => Trust.Kinds.indexOf(kind)).toSorted((a, b) => a - b),
    )
  })

  test("holds back a field it has no classification for", () => {
    // A document read by a newer schema can carry a field this table has never heard of.
    const unknown = Object.assign(new Info({ model: undefined }), { surprise: { run: "x" } })
    const result = ConfigTrust.sanitize(unknown)
    expect(result.info).not.toHaveProperty("surprise")
    expect(result.withheld).toEqual(["settings"])
  })

  test("never changes the document it was given", () => {
    const original = decode({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      permissions: [{ action: "shell", resource: "*", effect: "allow" }],
    })
    const before = JSON.stringify(original)
    ConfigTrust.sanitize(original)
    expect(JSON.stringify(original)).toBe(before)
    expect(original.hooks).toBeDefined()
  })
})

describe("ConfigTrust.stamp", () => {
  const document = (scope: Scope | undefined, input: unknown = { shell: "/bin/zsh", model: "acme/fast" }) =>
    new Document({
      type: "document",
      path: AbsolutePath.make(path.resolve("/repo/orbit.json")),
      scope,
      info: decode(input),
    })
  const directory = (scope: Scope | undefined) =>
    new Directory({ type: "directory", path: AbsolutePath.make(path.resolve("/repo/.orbit")), scope })

  test("leaves the entries of every other scope exactly as they are", () => {
    for (const scope of ["remote", "user", "flag", "managed", undefined] as const) {
      const entries = [document(scope), directory(scope)]
      for (const entry of entries) expect(ConfigTrust.stamp(entry)).toBe(entry)
    }
  })

  test("stamps the project and local entries and sanitizes their documents", () => {
    for (const scope of ["project", "local"] as const) {
      const stamped = ConfigTrust.stamp(
        document(scope, { shell: "/bin/zsh", model: "acme/fast", hooks: {}, websearch: { provider: "random" } }),
      )
      if (stamped.type !== "document") throw new Error("Expected a document")
      expect(stamped).toBeInstanceOf(Document)
      expect(stamped).toMatchObject({ scope, trusted: false, withheld: ["hooks", "shell", "network"] })
      expect(stamped.path).toBe(AbsolutePath.make(path.resolve("/repo/orbit.json")))
      expect<unknown>(stamped.info.model).toEqual({ providerID: "acme", model: "fast" })
      expect(stamped.info.shell).toBeUndefined()

      const stampedDirectory = ConfigTrust.stamp(directory(scope))
      expect(stampedDirectory).toBeInstanceOf(Directory)
      expect(stampedDirectory).toMatchObject({ type: "directory", scope, trusted: false })
    }
  })

  test("lists nothing for a document that held nothing back", () => {
    const stamped = ConfigTrust.stamp(document("project", { model: "acme/fast" }))
    expect(stamped).toMatchObject({ trusted: false, withheld: [] })
  })

  test("keeps a repository from masking the values the user set", () => {
    const user = document("user", {
      experimental: { portable_shell_scanner: true },
      sandbox: { enabled: true },
      formatter: false,
      websearch: false,
    })
    const project = document("project", {
      experimental: { portable_shell_scanner: false },
      sandbox: {},
      formatter: true,
      websearch: { provider: "random" },
    })
    const trusted: Entry[] = [user, project]
    const untrusted = [user, ConfigTrust.stamp(project)]

    // Trusted, the project outranks the user, whatever it sets.
    expect(Config.latest(trusted, "experimental")).toEqual({ portable_shell_scanner: false })
    expect(Config.latest(trusted, "sandbox")).toEqual({})
    expect(Config.latest(trusted, "formatter")).toBe(true)
    expect(Config.latest(trusted, "websearch")).toEqual({ provider: "random" })
    // Untrusted, none of it reaches the user's values.
    expect(Config.latest(untrusted, "experimental")).toEqual({ portable_shell_scanner: true })
    expect(Config.latest(untrusted, "sandbox")).toEqual({ enabled: true })
    expect(Config.latest(untrusted, "formatter")).toBe(false)
    expect(Config.latest(untrusted, "websearch")).toBe(false)
  })

  test("lets an untrusted project keep web search off over the user's provider", () => {
    const user = document("user", { websearch: { provider: "exa" } })
    expect(Config.latest([user, ConfigTrust.stamp(document("project", { websearch: false }))], "websearch")).toBe(false)
    expect<unknown>(
      Config.latest([user, ConfigTrust.stamp(document("local", { websearch: { provider: "random" } }))], "websearch"),
    ).toEqual({ provider: "exa" })
  })
})

describe("ConfigTrust.allows", () => {
  const base = path.resolve("/trust-fixture")
  const at = (...parts: string[]) => AbsolutePath.make(path.join(base, ...parts))
  const file = (...parts: string[]) => path.join(base, ...parts)
  const directory = (location: string, scope: Scope, trusted?: boolean) =>
    new Directory({ type: "directory", path: AbsolutePath.make(location), scope, trusted })
  const document = (location: string, scope: Scope, trusted?: boolean) =>
    new Document({ type: "document", path: AbsolutePath.make(location), scope, trusted, info: new Info({}) })

  test("allows a file under a global config directory and refuses one under an untrusted project directory", () => {
    const entries = [
      directory(file("config", "orbit"), "user"),
      directory(file("repo", ".orbit"), "project", false),
      document(file("repo", "orbit.json"), "project", false),
    ]
    expect(ConfigTrust.allows(entries, file("config", "orbit", "skills", "demo", "SKILL.md"))).toBe(true)
    expect(ConfigTrust.allows(entries, file("repo", ".orbit", "skills", "demo", "SKILL.md"))).toBe(false)
    expect(ConfigTrust.allows(entries, file("repo", ".orbit"))).toBe(false)
  })

  test("covers the folder an untrusted source configures, not only the source", () => {
    const entries = [directory(file("repo", ".orbit"), "project", false)]
    expect(ConfigTrust.allows(entries, file("repo", ".agents", "skills", "demo", "SKILL.md"))).toBe(false)
    expect(
      ConfigTrust.allows([document(file("repo", "orbit.json"), "project", false)], file("repo", "src", "tool.md")),
    ).toBe(false)
    expect(ConfigTrust.allows(entries, file("other", "skills", "SKILL.md"))).toBe(true)
    expect(ConfigTrust.allows(entries, file("repository", "skills", "SKILL.md"))).toBe(true)
  })

  test("allows everything once nothing is stamped untrusted", () => {
    const entries = [directory(file("repo", ".orbit"), "project"), document(file("repo", "orbit.json"), "project")]
    expect(ConfigTrust.allows(entries, file("repo", ".orbit", "skills", "demo", "SKILL.md"))).toBe(true)
    expect(ConfigTrust.allows([], file("repo", "anything"))).toBe(true)
  })

  test("lets the innermost source decide", () => {
    // The home directory holds an untrusted MCP file, and the user's own config directory sits inside it.
    const entries = [
      directory(file("home", ".config", "orbit"), "user"),
      directory(file("home", ".orbit"), "user"),
      document(file("home", ".mcp.json"), "project", false),
    ]
    expect(ConfigTrust.allows(entries, file("home", ".config", "orbit", "agents", "a.md"))).toBe(true)
    expect(ConfigTrust.allows(entries, file("home", ".orbit", "skills", "SKILL.md"))).toBe(true)
    expect(ConfigTrust.allows(entries, file("home", "work", "repo", ".agents", "skills", "SKILL.md"))).toBe(false)
    // And an untrusted source inside a trusted one is still untrusted.
    const nested = [
      directory(file("work", ".orbit"), "project"),
      directory(file("work", "repo", ".orbit"), "project", false),
    ]
    expect(ConfigTrust.allows(nested, file("work", "repo", ".orbit", "agents", "a.md"))).toBe(false)
    expect(ConfigTrust.allows(nested, file("work", ".orbit", "agents", "a.md"))).toBe(true)
  })

  test("ignores documents that have no file", () => {
    const entries = [new Document({ type: "document", scope: "flag", info: new Info({}) })]
    expect(ConfigTrust.allows(entries, at("repo", "file.md"))).toBe(true)
  })
})
