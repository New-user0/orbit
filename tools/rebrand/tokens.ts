/**
 * What the vendor gate (vendor.ts) looks for, as data: one entry per vendor.
 *
 * Every name below is written with a `|` inside it, and `spell` drops the bar when the table loads. That way no file
 * under tools/rebrand spells a name it looks for, and the gate passes on its own source. Keep it that way when adding
 * a vendor, comments included.
 *
 * There are two kinds of token, which the allowlist in vendor.ts treats differently:
 *
 * - Vendor names are a company's or a model family's words. Provider adapters name them because they talk to those
 *   vendors' APIs.
 * - Product tokens belong to an agent product itself: its name, its directory, its instruction and rule files, its
 *   environment variables, its IDE header and its web app. Only the compatibility package, which reads those products'
 *   files, may name them.
 */

export type Vendor = {
  /** What the gate calls the vendor when it reports a hit. */
  readonly label: string
  /** Company and model-family words, matched anywhere in a word: `FooClient` and `foo-bar` both count. */
  readonly names: readonly string[]
  /** Short words that only count when no letter touches them, so a longer word that contains one does not. */
  readonly words?: readonly string[]
  readonly product?: {
    /** Product names. A name is its words in order, joined by a space, an underscore or a hyphen, or by nothing. */
    readonly names?: readonly (readonly string[])[]
    /** Directories, matched as a path segment: a property access that happens to share the name does not count. */
    readonly directories?: readonly string[]
    /** Instruction and rule files. */
    readonly files?: readonly string[]
    /** Variable names or prefixes, case sensitive. A model family's own prefix is not one: provider code names it. */
    readonly env?: readonly string[]
    /** Request headers, which an IDE integration identifies itself with. */
    readonly headers?: readonly string[]
    /** The product's own web app. A provider's API host is not one. */
    readonly domains?: readonly string[]
  }
}

/** The name without the bar that keeps this source from spelling it. */
export const spell = (value: string) => value.replaceAll("|", "")

const spellAll = (values: readonly string[] | undefined) => values?.map(spell)

/**
 * The vendors Orbit reads files from or names today: the reference harness, and every other agent product whose
 * files Orbit already lists, in `/init` or in the lint ignore list.
 *
 * Some products have no name token because their name is an everyday word: a terminal has a cursor, a program
 * continues and a circle has a pi. Their directories and files still count.
 */
const table: readonly Vendor[] = [
  {
    label: "reference harness",
    names: ["anthro|pic", "cla|ude"],
    product: {
      names: [["cla|ude", "code"]],
      directories: [".cla|ude"],
      files: ["CLA|UDE.md", "CLA|UDE.local.md", ".cla|ude.json"],
      env: ["CLA|UDE_CODE_", "CLA|UDE_CONFIG_DIR", "CLA|UDE_ENV_FILE", "CLA|UDE_PLUGIN_ROOT", "CLA|UDE_PROJECT_DIR"],
      headers: ["x-cla|ude-code-ide-authorization"],
      domains: ["cla|ude.ai"],
    },
  },
  {
    label: "cur|sor",
    names: ["any|sphere"],
    product: {
      directories: [".cur|sor"],
      files: [".cur|sorrules"],
      domains: ["cur|sor.com", "cur|sor.sh"],
    },
  },
  {
    label: "github co|pilot",
    names: ["co|pilot"],
    product: {
      files: ["co|pilot-instructions.md"],
    },
  },
  {
    label: "open|ai co|dex",
    names: ["open|ai", "chat|g|pt"],
    words: ["g|pt", "co|dex"],
    product: {
      names: [["co|dex", "cli"]],
      directories: [".co|dex"],
      env: ["CO|DEX_HOME", "CO|DEX_SANDBOX"],
    },
  },
  {
    label: "gem|ini cli",
    names: ["goo|gle", "gem|ini"],
    product: {
      names: [["gem|ini", "cli"]],
      directories: [".gem|ini"],
      files: ["GEM|INI.md"],
      env: ["GEM|INI_CLI_"],
    },
  },
  {
    label: "wind|surf",
    names: ["code|ium"],
    product: {
      names: [["wind|surf"]],
      directories: [".wind|surf"],
      files: [".wind|surfrules"],
      domains: ["wind|surf.com"],
    },
  },
  {
    label: "r|oo code",
    names: [],
    product: {
      names: [["r|oo", "code"]],
      directories: [".r|oo"],
      files: [".r|oorules", ".r|oomodes"],
      domains: ["r|oocode.com"],
    },
  },
  {
    label: "con|tinue",
    names: [],
    product: {
      directories: [".con|tinue"],
      files: [".con|tinuerules"],
      domains: ["con|tinue.dev"],
    },
  },
  {
    label: "p|i",
    names: [],
    product: {
      directories: [".p|i"],
    },
  },
]

export const vendors: readonly Vendor[] = table.map((vendor) => ({
  label: spell(vendor.label),
  names: vendor.names.map(spell),
  words: spellAll(vendor.words),
  product: vendor.product && {
    names: vendor.product.names?.map((words) => words.map(spell)),
    directories: spellAll(vendor.product.directories),
    files: spellAll(vendor.product.files),
    env: spellAll(vendor.product.env),
    headers: spellAll(vendor.product.headers),
    domains: spellAll(vendor.product.domains),
  },
}))

/**
 * Directories that several agent products share. Orbit reads skills from them through the compatibility package, so
 * they are not any one product's brand and are not token matches. What a tool leaves untracked in them is still that
 * tool's local state, so they are listed with the product directories to skip.
 */
export const shared = [".agent", ".agents"]

/** Every directory in which untracked files are another tool's local state. */
export const directories = [...vendors.flatMap((vendor) => vendor.product?.directories ?? []), ...shared]
