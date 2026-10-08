import { resolve, type Info, type Resolved } from "../../src/config"
import { TuiKeybind } from "../../src/config/keybind"
import type { KeybindingsFile } from "../../src/config/keybindings-file"

type ResolvedInput = Omit<Info, "attention" | "keybinds" | "leader"> & {
  attention?: Partial<Resolved["attention"]>
  keybinds?: Partial<TuiKeybind.Keybinds>
  leader?: { timeout?: number }
}

export function createTuiResolvedConfig(
  input: ResolvedInput = {},
  options?: { terminal?: boolean; keybindings?: KeybindingsFile.Result },
) {
  const config = resolve(input, {
    terminalSuspend: process.platform !== "win32",
    environment: {},
    keybindings: options?.keybindings,
  })
  return {
    ...config,
    session: { ...config.session, terminal: options?.terminal ?? config.session.terminal },
  }
}
