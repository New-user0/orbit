export type SandboxProbe =
  | { readonly type: "wrapped"; readonly command: string }
  | { readonly type: "unwrapped" }
  | { readonly type: "missing"; readonly tool: string }
  | { readonly type: "unsupported"; readonly reason: string }

/** Whether the sandbox is on: known only from managed settings, which replace every lower scope's `sandbox`. */
export type SandboxState = "on" | "off" | "unknown"

export function sandboxState(managed: { readonly enabled?: boolean } | undefined): SandboxState {
  if (managed === undefined) return "unknown"
  return managed.enabled === true ? "on" : "off"
}

/**
 * The `sandbox` line of `orb doctor`. It goes red only when managed settings turn the sandbox on and it cannot work,
 * as a problem with a tool matters only to someone who asked for the sandbox. It never prints a setting value.
 */
export function sandboxCheck(probe: SandboxProbe, state: SandboxState) {
  const label = "sandbox"
  const source = state === "on" ? "on in managed settings; " : state === "off" ? "off in managed settings; " : ""
  const failing = state === "on" ? false : undefined
  const install = (tool: string) =>
    tool === "bwrap"
      ? "install the distribution's bubblewrap package"
      : `${tool} ships with macOS in /usr/bin, so PATH must include it`
  if (probe.type === "wrapped")
    return {
      ok: state === "on" ? true : undefined,
      label,
      detail: `${source}${probe.command} is available`,
    }
  if (probe.type === "missing")
    return {
      ok: failing,
      label,
      detail:
        state === "on"
          ? `${source}${probe.tool} is not on PATH, so every shell command fails until it is available (${install(probe.tool)}) or the sandbox is turned off`
          : state === "off"
            ? `${source}turning it on needs ${probe.tool}, which is not on PATH`
            : `${probe.tool} is not on PATH; shell commands would fail if the sandbox were turned on`,
    }
  if (probe.type === "unsupported")
    return {
      ok: failing,
      label,
      detail:
        state === "on"
          ? `${source}${probe.reason}`
          : state === "off"
            ? `${source}WSL1 cannot sandbox; turning it on would make shell commands fail (use WSL2)`
            : "WSL1 cannot sandbox; shell commands would fail if the sandbox were turned on (use WSL2)",
    }
  return {
    ok: failing,
    label,
    detail:
      state === "on"
        ? `${source}this platform has no OS sandbox, so shell commands run unsandboxed despite the setting`
        : `${source}no OS sandbox on this platform`,
  }
}
