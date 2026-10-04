#!/usr/bin/env bun
/**
 * Vendor branding gate.
 *
 *   bun tools/rebrand/vendor.ts --check   exit 1 if a vendor's name or files appear outside the allowlist
 *
 * Orbit reads other agent products' files through packages/compat and talks to many model vendors through provider
 * adapters, and nowhere else names either. tokens.ts holds what to look for, as data, and tells vendor names from
 * product tokens. The allowlist below holds where each may appear.
 *
 * This is the one allowlist. Every entry says why it is there, and a reviewer reads a change to it like code: before
 * adding one, try moving the line into packages/compat or rewording it.
 */
import { listFiles, readText } from "./files.ts"
import { spell, vendors } from "./tokens.ts"

type Entry = {
  /**
   * `names` allows vendor names, which is what provider adapters need. `products` allows product tokens as well, and
   * is for the few places that carry another product's files by design.
   */
  readonly allow: "names" | "products"
  /** Globs relative to the root. A path that names a vendor is written the way tokens.ts writes names: with a `|`. */
  readonly paths: readonly string[]
  readonly reason: string
}

type Token = {
  readonly kind: "product" | "name"
  readonly vendor: string
  readonly regex: RegExp
}

type Hit = {
  readonly file: string
  /** Missing when the path is the hit. */
  readonly line?: number
  readonly text: string
  readonly vendor: string
  readonly kind: Token["kind"]
}

const allowlist: readonly Entry[] = [
  {
    allow: "products",
    paths: ["packages/compat/**"],
    reason:
      "The compatibility package is the one place that names other agent products' files, settings, tools and variables, so the rest of Orbit never spells them. Its tests build fixtures of those files.",
  },
  {
    allow: "products",
    paths: ["THIRD_PARTY_NOTICES.txt"],
    reason:
      "The notice credits the projects Orbit was built from and has to name them, the way the brand gate also allows it.",
  },
  {
    allow: "products",
    paths: [".oxlintrc.json"],
    reason:
      "The lint ignore list names other agent products' directories, which hold their generated and local files and are not Orbit's to lint.",
  },
  {
    allow: "products",
    paths: [".gitignore"],
    reason: "The ignore list keeps other agent products' local state directories out of commits.",
  },
  {
    allow: "products",
    paths: ["packages/core/src/models-dev/snapshot.txt"],
    reason:
      "A snapshot of a third-party model catalog, refreshed by core/script/update-models-snapshot.ts and never edited by hand. It lists whatever the catalog lists, including model ids and providers named after other products.",
  },
  {
    allow: "names",
    paths: ["packages/ai/**"],
    reason:
      "The AI package is the provider adapter layer: protocols, routes, models, recorded traffic, examples and docs name each vendor's API and model families.",
  },
  {
    allow: "names",
    paths: [
      "packages/core/src/aisdk*.ts",
      "packages/core/src/model-resolver.ts",
      "packages/core/src/model.ts",
      "packages/core/src/provider.ts",
      "packages/core/src/variant.ts",
      "packages/core/src/plugin/models-dev.ts",
      "packages/core/src/plugin/optimize.ts",
      "packages/core/src/plugin/provider/**",
      "packages/core/src/session/runner/model.ts",
    ],
    reason:
      "Core's provider and model plumbing: provider ids, model families, per-vendor reasoning variants and request options, and the plugins that configure each provider.",
  },
  {
    allow: "names",
    paths: ["packages/core/src/plugin/provider.ts", "packages/core/src/plugin/verbosity.ts"],
    reason:
      "Core provider plugins: one registers every provider plugin by vendor, the other sets an option that only some vendors' models take.",
  },
  {
    allow: "names",
    paths: ["packages/core/src/models-dev.ts", "packages/core/src/modal/models.ts"],
    reason:
      "Both map models to the adapter package that serves them, and that package is named after a vendor's wire protocol.",
  },
  {
    allow: "names",
    paths: ["packages/core/src/plugin/system-prompt/**"],
    reason: "Each file is the system prompt for one model family and is named after it.",
  },
  {
    allow: "names",
    paths: ["packages/core/src/github-co|pilot/**"],
    reason: "A provider with its own chat and responses clients and its own model list.",
  },
  {
    allow: "names",
    paths: ["packages/core/src/v1/**"],
    reason: "Version 1 configuration: its schema and migration still name the providers it configured.",
  },
  {
    allow: "names",
    paths: ["packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts"],
    reason: "Imports the credentials earlier versions saved, and picks each provider's login method by its id.",
  },
  {
    allow: "names",
    paths: ["packages/core/src/tool/plugin/patch.ts"],
    reason: "Offers `patch` in place of `edit` and `write` to the model families that are trained on the patch format.",
  },
  {
    allow: "names",
    paths: ["packages/core/script/**"],
    reason: "Build, test and benchmark scripts that handle provider credentials and the model catalog.",
  },
  {
    allow: "names",
    paths: ["packages/schema/src/provider.ts"],
    reason: "The provider id schema lists the vendors Orbit has an adapter for.",
  },
  {
    allow: "names",
    paths: ["packages/cli/src/commands/handlers/auth/login.ts", "packages/tui/src/component/dialog-integration.tsx"],
    reason: "Each ranks the providers a person is offered first when connecting one, by provider id.",
  },
  {
    allow: "names",
    paths: ["packages/tui/src/routes/session/rows.ts"],
    reason:
      "Does not report a cache-read drop of one or two cache buckets as a cache break, for the one provider whose cache works in buckets of that size.",
  },
  {
    allow: "names",
    paths: ["packages/http-recorder/src/redaction/**", "packages/http-recorder/README.md"],
    reason:
      "Redaction rules match each vendor's credential formats and headers, and the README records one vendor's API as its example.",
  },
  {
    allow: "names",
    paths: ["packages/simulation/src/backend/index.ts", "packages/simulation/src/backend/open|ai.ts"],
    reason:
      "The simulated network answers as one vendor's chat endpoint, so the real adapter code runs against it unchanged.",
  },
  {
    allow: "names",
    paths: ["**/package.json", "bun.lock", "bunfig.toml", "patches/**"],
    reason:
      "Package manifests, the lockfile and the patches to vendors' SDK packages name those packages, and a patch is named after the one it changes.",
  },
  {
    allow: "names",
    paths: ["tools/tachyon-probe/**"],
    reason: "The probe sends the same requests to several vendors' models through the gateway it measures.",
  },
  {
    allow: "names",
    paths: ["packages/*/test/**", "**/*.test.ts", "**/*.test.tsx"],
    reason:
      "Tests use real vendor ids and formats as fixtures. They may not name other products' files: those go through packages/compat.",
  },
  {
    allow: "names",
    paths: ["README.md", "packages/vscode/README.md"],
    reason: "Each says which model providers Orbit works with, by name.",
  },
  {
    allow: "names",
    paths: ["docs/flow.md", "docs/tachyon.md", "docs/try-it-windows.md"],
    reason:
      "Pages about the Tachyon gateway and the workflows run through it. The gateway serves vendors' models under their own ids, and the examples and probe results use them.",
  },
  {
    allow: "names",
    paths: ["docs/fork-map.md"],
    reason:
      "The audit of what the fork changed from upstream names the provider adapters and login flows that carry a vendor's name.",
  },
  {
    allow: "names",
    paths: ["packages/plugin/src/effect/PLAN.md"],
    reason: "Design notes whose plugin examples configure a provider by its id.",
  },
]

const globs = allowlist.map((entry) => ({
  allow: entry.allow,
  globs: entry.paths.map((path) => new Bun.Glob(spell(path))),
}))

// A path segment starts after anything but a word character, a dot, a hyphen or the end of an expression, so a
// property access such as `options?.name` is not taken for a directory or file called `.name`.
const segment = String.raw`(?<![\w.?)\]-])`
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

const products = vendors.flatMap((vendor): Token[] => {
  const token = (regex: RegExp): Token => ({ kind: "product", vendor: vendor.label, regex })
  const product = vendor.product
  return [
    ...(product?.names ?? []).map((words) => token(new RegExp(words.map(escape).join("[ _-]?"), "i"))),
    // Not followed by `.word`, so `.dir.next` is a property chain and `.dir.json` is left to the files below. A line
    // that starts with the directory after its indentation continues a member chain, unless a path separator follows.
    ...(product?.directories ?? []).map((value) =>
      token(new RegExp(String.raw`(?<!^\s+)${segment}${escape(value)}(?!\.?\w)|^\s+${escape(value)}(?=[/\\])`, "i")),
    ),
    ...(product?.files ?? []).map((value) => token(new RegExp(`${segment}${escape(value)}(?!\\w)`, "i"))),
    // Case sensitive, and a prefix: the variable names under it vary.
    ...(product?.env ?? []).map((value) => token(new RegExp(`(?<![A-Za-z0-9_])${escape(value)}`))),
    ...(product?.headers ?? []).map((value) => token(new RegExp(escape(value), "i"))),
    ...(product?.domains ?? []).map((value) => token(new RegExp(`(?<![\\w-])${escape(value)}(?![\\w-])`, "i"))),
  ]
})

const names = vendors.flatMap((vendor): Token[] => {
  const token = (regex: RegExp): Token => ({ kind: "name", vendor: vendor.label, regex })
  return [
    ...vendor.names.map((word) => token(new RegExp(escape(word), "i"))),
    ...(vendor.words ?? []).map((word) => token(new RegExp(`(?<![a-z])${escape(word)}(?![a-z])`, "i"))),
  ]
})

// What a file is searched for: every token as one case-insensitive pattern, which is the cheap test a line has to pass
// before the tokens are tried one by one. Product tokens come first, so a line that has both kinds is reported as the
// more serious one.
const search = (list: Token[]) => ({
  list,
  any: new RegExp(list.map((token) => token.regex.source).join("|"), "i"),
})
const everything = search([...products, ...names])
const productsOnly = search(products)

// --check is the only mode, so running the file with no argument checks too.
if ((process.argv[2] ?? "--check") !== "--check") {
  console.error("usage: bun tools/rebrand/vendor.ts --check")
  process.exit(2)
}

const files = await listFiles()
const hits = await check(files)
if (hits.length > 0) {
  console.error(
    hits
      .slice(0, 200)
      .map((hit) => `${hit.line === undefined ? hit.file : `${hit.file}:${hit.line}`}: ${hit.text}`)
      .join("\n"),
  )
  console.error(`\n${hits.length} vendor reference(s) found in ${new Set(hits.map((hit) => hit.file)).size} file(s).`)
  console.error(summary(hits))
  console.error(
    "Product tokens belong in packages/compat. Vendor names belong in provider adapters. Reword the line, or add an\n" +
      "allowlist entry with a reason to tools/rebrand/vendor.ts.",
  )
  process.exit(1)
}
console.log(`vendor check passed (${files.length} file(s))`)

async function check(list: string[]): Promise<Hit[]> {
  const results = await Promise.all(
    list.map(async (file) => {
      const level = allowed(file)
      if (level === "products") return []
      const active = level === "names" ? productsOnly : everything
      const pathHit = find(file, active.list)
      const text = await readText(file)
      return [
        ...(pathHit ? [{ file, text: "(path)", vendor: pathHit.token.vendor, kind: pathHit.token.kind }] : []),
        ...(text === undefined ? [] : lines(file, text, active)),
      ]
    }),
  )
  return results.flat()
}

function lines(file: string, text: string, active: typeof everything): Hit[] {
  return text.split("\n").flatMap((line, index) => {
    if (!active.any.test(line)) return []
    const hit = find(line, active.list)
    if (!hit) return []
    return [{ file, line: index + 1, text: excerpt(line, hit.index), vendor: hit.token.vendor, kind: hit.token.kind }]
  })
}

function find(value: string, list: Token[]) {
  return list
    .flatMap((token) => {
      const match = token.regex.exec(value)
      return match ? [{ token, index: match.index }] : []
    })
    .at(0)
}

// The strongest allowance among the entries that match: `products` covers everything, `names` only vendor names.
function allowed(file: string) {
  const matching = globs.filter((entry) => entry.globs.some((glob) => glob.match(file)))
  if (matching.some((entry) => entry.allow === "products")) return "products"
  return matching.length > 0 ? "names" : undefined
}

// Minified and generated files have lines no one can read, so a long line is cut around the match.
function excerpt(line: string, index: number) {
  if (line.length <= 160) return line.trim()
  const start = Math.max(0, index - 60)
  return `${start > 0 ? "..." : ""}${line.slice(start, start + 160).trim()}`
}

function summary(found: Hit[]) {
  const count = (kind: Hit["kind"]) => found.filter((hit) => hit.kind === kind).length
  const byVendor = Object.entries(Object.groupBy(found, (hit) => hit.vendor))
    .map(([vendor, group]) => `${vendor} ${group?.length}`)
    .join(", ")
  return `${count("product")} product token(s), ${count("name")} vendor name(s). By vendor: ${byVendor}.`
}
