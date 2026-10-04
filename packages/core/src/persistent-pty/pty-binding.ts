// No persistent PTY daemon ships with this build; PersistentPty reports itself unavailable unless a
// binary is supplied through the environment (see binary.bun.ts).
const binding: string | { readonly path: string; readonly version: string; readonly sha256: string } | undefined =
  undefined

export default binding
