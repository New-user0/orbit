import type { BunPlugin } from "bun"

/**
 * A name that a bundled dependency looks up while it runs, in a way that the bundler cannot follow, is left to the
 * runtime of the compiled binary, and Bun resolves it from the folder the binary starts in. That folder can be a
 * repository that is not trusted yet, and the binary starts there before any trust check, `orb trust` and the server it
 * starts included, so a file that the repository commits to its `node_modules` ran. Three dependencies did it, and each
 * is replaced here by a module that looks nothing up:
 *
 * - js-yaml loads `esprima` for its `!!js/function` type when it loads, through `var _require = require`. Front matter is
 *   only read with the safe schema, which has no such type, so the type becomes one that matches nothing and esprima is
 *   not needed.
 * - Babel, which transforms the source of a plugin that the terminal UI loads, hands the browserslist config of the
 *   folder it runs in to browserslist. A config that `extends` a package loads that package from the folder, and a
 *   `supports <feature>` query loads the caniuse-lite file of the feature from it. Nothing that Orbit transforms reads
 *   targets, so Babel's browser build of the lookup, which reads no config, takes its place.
 * - fff, the file finder, loads the native library of an npm package that its lookup finds before it loads the one that
 *   is embedded in the binary, unless the path of the embedded one contains `$bunfs`. On Windows it contains `~BUN`, so
 *   the lookup starts at the virtual root of the binary and ends in the folder: the `node_modules/@ff-labs/fff-bin-win32-x64`
 *   of a repository supplied a library that was loaded as native code, when fff is on, which on Windows takes
 *   `ORBIT_DISABLE_FFF=0`. The library is always embedded, so the lookup finds nothing.
 *
 * The other names that the bundle leaves to the runtime are not looked up in the folder. `ws` and `utf-8-validate` are
 * modules that Bun carries itself, and nothing asks for `bufferutil`. `node-gyp/bin/node-gyp.js` is only a path that npm
 * reads, and Orbit installs with scripts off. A workflow, suite, plugin or provider that Orbit loads is imported on
 * purpose. Look for `__require(`, a `require` that is assigned, `createRequire` and `import.meta.resolve` in the
 * unminified bundle when a dependency changes.
 */
const replacements = [
  {
    name: "js-yaml js/function",
    filter: /js-yaml[\\/]lib[\\/]js-yaml[\\/]type[\\/]js[\\/]function\.js$/,
    contents: async () =>
      [
        `var Type = require("../../type")`,
        `module.exports = new Type("tag:yaml.org,2002:js/function", { kind: "scalar", resolve: function () { return false } })`,
      ].join("\n"),
  },
  {
    name: "Babel resolve-targets",
    filter: /@babel[\\/]core[\\/]lib[\\/]config[\\/]resolve-targets\.js$/,
    contents: (file: string) => Bun.file(file.replace(/resolve-targets\.js$/, "resolve-targets-browser.js")).text(),
  },
  {
    name: "fff-bun download",
    filter: /@ff-labs[\\/]fff-bun[\\/]src[\\/]download\.ts$/,
    contents: async () => [`export const findBinary = () => null`, `export const binaryExists = () => false`].join("\n"),
  },
]

export function runtimeRequires(replaced: Set<string>): BunPlugin {
  return {
    name: "orbit-runtime-requires",
    setup(build) {
      for (const replacement of replacements)
        build.onLoad({ filter: replacement.filter }, async (args) => {
          replaced.add(replacement.name)
          return { contents: await replacement.contents(args.path), loader: "js" }
        })
    },
  }
}

// A replacement that no module of the build matched is not in effect, so the build fails instead of shipping without it.
export function verifyRuntimeRequires(replaced: ReadonlySet<string>) {
  const missing = replacements.filter((replacement) => !replaced.has(replacement.name))
  if (missing.length > 0)
    throw new Error(
      `Build graph never loaded what runtime-requires replaces: ${missing.map((replacement) => replacement.name).join(", ")}`,
    )
}
