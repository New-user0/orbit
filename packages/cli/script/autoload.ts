/**
 * What the compiled binary loads from the folder it starts in, which is nothing. That folder can be a repository that
 * is not trusted yet, and the binary starts there before any trust check, `orb trust` and the server it starts included.
 * Bun applies the `paths` of a `tsconfig.json` and the `imports` of a `package.json` that it finds there to the module
 * resolution of the binary itself, so a committed file could point an import inside the binary at a file of the
 * repository and run it. `bunfig.toml` and `.env` are read from the folder the same way.
 */
export const autoload = {
  autoloadBunfig: false,
  autoloadDotenv: false,
  autoloadTsconfig: false,
  autoloadPackageJson: false,
} as const
