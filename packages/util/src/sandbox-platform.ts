export * as SandboxPlatform from "./sandbox-platform.js"

/**
 * Which kind of system a shell sandbox would run on. WSL1 is a translation layer without the namespaces bubblewrap
 * needs, so it is told apart from WSL2, which runs a real Linux kernel.
 */
export type Kind = "linux" | "wsl1" | "wsl2" | "darwin" | "win32"

export interface Input {
  readonly platform: NodeJS.Platform
  /** `os.release()`. Only read on Linux. */
  readonly release: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** The sandbox tool each kind of system uses. Kinds without an entry have no sandbox tool. */
export const TOOL: Partial<Record<Kind, string>> = { linux: "bwrap", wsl2: "bwrap", darwin: "sandbox-exec" }

export function platform(input: Input): Kind | undefined {
  if (input.platform === "darwin") return "darwin"
  if (input.platform === "win32") return "win32"
  if (input.platform !== "linux") return undefined
  const release = input.release.toLowerCase()
  if (release.includes("microsoft-standard") || release.includes("wsl2")) return "wsl2"
  // WSL1 reports a Microsoft release without the "standard" kernel name.
  if (release.includes("microsoft")) return "wsl1"
  // A custom WSL2 kernel can carry any release string and WSL1 never does, so the distro name only promotes an
  // otherwise plain release to wsl2.
  if (input.env.WSL_DISTRO_NAME) return "wsl2"
  return "linux"
}
