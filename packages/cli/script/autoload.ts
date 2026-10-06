/**
 * What the compiled binary loads from the folder it starts in: the `package.json` files that module resolution reads,
 * and nothing else. That folder can be a repository that is not trusted yet, and the binary starts there before any
 * trust check, `orb trust` and the server it starts included. Bun applies the `paths` of a `tsconfig.json` that it finds
 * there to the module resolution of the binary itself, so a committed file could map every import inside the binary to a
 * file of the repository and run it. That was the demonstrated attack, so `tsconfig.json` is off, and so are
 * `bunfig.toml` (a `preload`) and `.env` (`BUN_OPTIONS`), which Bun reads from the folder the same way.
 *
 * `package.json` stays on: with it off the binary reads no package.json at runtime, so it cannot find the entry that a
 * package names with `main` or `exports`, and a workflow, suite or plugin module that imports such a package, an npm
 * plugin and an `aisdk:` provider that has no built-in plugin stop loading. Its `imports` field would map a `#name`
 * import inside the binary to a file of the repository, but the binary imports no `#name` at runtime: the bundler
 * resolves every one of them when it builds. Nothing may import a `#name` that is left to the runtime, so look for
 * `import("#`, `require("#` and `from"#` in the build when a dependency or a dynamic import changes.
 */
export const autoload = {
  autoloadBunfig: false,
  autoloadDotenv: false,
  autoloadTsconfig: false,
  autoloadPackageJson: true,
} as const
