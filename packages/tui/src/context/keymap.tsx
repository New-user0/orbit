import type { KeymapActive, KeymapCommand, KeymapLayer, KeymapPending } from "@orbit/plugin/tui/context"
import { InputRenderable, TextareaRenderable, type KeyEvent, type Renderable } from "@opentui/core"
import { stringifyKeyStroke, type Binding, type CommandContext, type KeyLike } from "@opentui/keymap"
import {
  registerBackspacePopsPendingSequence,
  registerBaseLayoutFallback,
  registerEscapeClearsPendingSequence,
  registerManagedTextareaLayer,
  registerTimedLeader,
} from "@opentui/keymap/addons/opentui"
import { formatCommandBindings, formatKeySequence } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useBindings, useKeymapSelector } from "@opentui/keymap/solid"
import { useRenderer } from "@opentui/solid"
import {
  createComputed,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js"
import { useConfig } from "../config"
import { TuiKeybind } from "../config/keybind"
import { resolveInteractivity, useInteractivity } from "./interactivity"

declare module "@opentui/keymap" {
  interface Command {
    orbit?: KeymapCommand
    slash?: {
      name: string
      aliases?: string[]
      arguments?: true
    }
  }
}

const MODE = { key: "orbit.mode", base: "base" } as const

type OpenTuiKeymap = Parameters<typeof KeymapProvider>[0]["keymap"]
type Mode = ReturnType<typeof createMode>
type KeymapConfig = {
  readonly keybinds: {
    get(command: string): readonly Binding<Renderable, KeyEvent>[]
    override?: TuiKeybind.BindingLookupView["override"]
  }
  readonly leader?: { readonly timeout: number }
  readonly leader_timeout?: number
}

// Input commands bound to a text area by the managed layer, whose keys come from the config.
const INPUT_COMMANDS = [
  "input.move.left",
  "input.move.right",
  "input.move.up",
  "input.move.down",
  "input.select.left",
  "input.select.right",
  "input.select.up",
  "input.select.down",
  "input.line.home",
  "input.line.end",
  "input.select.line.home",
  "input.select.line.end",
  "input.visual.line.home",
  "input.visual.line.end",
  "input.select.visual.line.home",
  "input.select.visual.line.end",
  "input.buffer.home",
  "input.buffer.end",
  "input.select.buffer.home",
  "input.select.buffer.end",
  "input.delete.line",
  "input.delete.to.line.end",
  "input.delete.to.line.start",
  "input.backspace",
  "input.delete",
  "input.newline",
  "input.undo",
  "input.redo",
  "input.word.forward",
  "input.word.backward",
  "input.select.word.forward",
  "input.select.word.backward",
  "input.delete.word.forward",
  "input.delete.word.backward",
  "input.select.all",
  "input.submit",
]

export const COMMAND_PALETTE_COMMAND = "command.palette.show"

const Context = createContext<{
  readonly keymap: OpenTuiKeymap
  readonly config: KeymapConfig
  readonly mode: Mode
  readonly dispatch: (id: string, input?: string) => void
  readonly input: (id: string) => string | undefined
}>()

function Provider(props: ParentProps<{ config?: KeymapConfig }>) {
  const renderer = useRenderer()
  const config: KeymapConfig = props.config ?? useConfig().data
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const mode = createMode(keymap)
  let invocation: { readonly id: string; readonly input?: string } | undefined
  const dispatch = (id: string, input?: string) => {
    const previous = invocation
    invocation = { id, input }
    try {
      keymap.dispatchCommand(id)
    } finally {
      invocation = previous
    }
  }
  const dispose = [
    // Commas, spelled-out keys and chords such as `ctrl+k ctrl+s`. The latter use the same strokes as a <leader> sequence
    // and never touch one, because a <leader> sequence has no space in it.
    ...TuiKeybind.registerSyntax(keymap),
    registerBaseLayoutFallback(keymap),
    registerEscapeClearsPendingSequence(keymap),
    registerBackspacePopsPendingSequence(keymap),
  ]
  // The leader key and the text-area keys are registered once with the keys they have, so they register again when a
  // change to the config, such as an edit of the keybindings file, gives them other keys. A reload rewrites the objects
  // of the config in place, which leaves nothing to tell the old keys from the new ones, so each memo holds the keys as
  // text and the computations below read them back from it.
  const leader = createMemo(() => JSON.stringify(config.keybinds.get("leader")?.[0]?.key))
  createComputed(() => {
    const written = leader()
    if (!written) return
    const trigger: KeyLike = JSON.parse(written)
    onCleanup(
      registerTimedLeader(keymap, {
        trigger,
        name: "leader",
        timeoutMs: config.leader?.timeout ?? ("leader_timeout" in config ? config.leader_timeout : undefined) ?? 2000,
      }),
    )
  })
  const inputBindings = createMemo(() =>
    JSON.stringify(INPUT_COMMANDS.flatMap((command) => config.keybinds.get(command))),
  )
  createComputed(() => {
    const bindings: Binding<Renderable, KeyEvent>[] = JSON.parse(inputBindings())
    onCleanup(
      registerManagedTextareaLayer(keymap, renderer, {
        enabled: () => {
          const editor = renderer.currentFocusedEditor
          return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable)
        },
        // Layers rank by priority and then by when they registered, and this one was always the oldest. Registering it
        // again must not put it above the app's own layers, so it ranks below all of them whenever it registers.
        priority: -1,
        bindings,
      }),
    )
  })
  onCleanup(() => {
    dispose.reverse().forEach((item) => item())
    mode.dispose()
  })
  return (
    <KeymapProvider keymap={keymap}>
      <Context.Provider
        value={{
          keymap,
          config,
          mode,
          dispatch,
          input: (id) => (invocation?.id === id ? invocation.input : undefined),
        }}
      >
        {props.children}
      </Context.Provider>
    </KeymapProvider>
  )
}

export type { KeymapCommand, KeymapLayer } from "@orbit/plugin/tui/context"

export interface Keymap {
  /** Dispatches a reachable command by ID. */
  dispatch(id: string, input?: string): void
  /** Controls mutually exclusive Orbit input modes. */
  readonly mode: {
    /** Returns the active mode. */
    current(): string
    /** Pushes a mode until the returned cleanup is called. */
    push(mode: string): () => void
  }
  /** Registers a low-level keymap interceptor. */
  intercept: OpenTuiKeymap["intercept"]
  /** Returns whether an event matches the configured leader key. */
  isLeader(event: KeyEvent): boolean
}

function use(): Keymap {
  const value = useValue()
  const enabled = useInteractivity()
  return {
    dispatch(id, input) {
      value.dispatch(id, input)
    },
    mode: {
      current: value.mode.current,
      push: (mode) => value.mode.push(mode, resolveInteractivity(enabled)),
    },
    intercept: value.keymap.intercept.bind(value.keymap),
    // Read on every call, because the keybindings file can change the leader key while the app runs.
    isLeader(event) {
      const leader = value.config.keybinds.get("leader")?.[0]?.key
      return leader ? value.keymap.createKeyMatcher(leader)(event) : false
    },
  }
}

function createLayer(input: () => KeymapLayer) {
  const value = useValue()
  const enabled = useInteractivity()
  useBindings(() => {
    const layer = input()
    const { commands, bindings, mode, context, ...options } = layer
    // A layer without a context, or with one that is not Orbit's, only ever gets the keys that apply everywhere.
    const place = TuiKeybind.isContext(context) ? context : undefined
    // What the keybindings file sets decides first: for this context, then for all of them. An empty list is a command it
    // unbinds, which the command's own default key must not bring back.
    const fromFile = (id: string) => value.config.keybinds.override?.(place, id)
    const grouped = (commands ?? []).reduce(
      (result, command) => {
        if (command.id !== undefined) {
          if (!command.id) throw new Error("Keymap command IDs cannot be empty")
          if (typeof command.bind === "string" && !command.bind)
            throw new Error("Keymap command bindings cannot be empty")
          result.named.push({ ...command, id: command.id })
          return result
        }
        if (command.palette) throw new Error("Palette commands require an ID")
        if (command.slash) throw new Error("Slash commands require an ID")
        if (typeof command.bind !== "string") throw new Error("Inline keymap commands require bind")
        if (!command.bind) throw new Error("Keymap command bindings cannot be empty")
        result.inline.push({ ...command, id: undefined, bind: command.bind })
        return result
      },
      {
        named: [] as Array<KeymapCommand & { readonly id: string }>,
        inline: [] as Array<KeymapCommand & { readonly id?: undefined; readonly bind: string }>,
      },
    )
    return {
      ...options,
      enabled: enabled() ? options.enabled : false,
      ...(mode === "global" ? {} : { mode: mode ?? MODE.base }),
      commands: grouped.named.map((command) => {
        const { id, description, group, palette, bind, run, ...definition } = command
        return {
          ...definition,
          name: id,
          orbit: command,
          run: (context: CommandContext<Renderable, KeyEvent>) => run(value.input(id), context.event),
          ...(description === undefined ? {} : { desc: description }),
          ...(group === undefined ? {} : { category: group }),
          ...(palette === undefined ? {} : { namespace: "palette" }),
        }
      }),
      bindings: [
        ...grouped.inline.map((command) => ({
          key: command.bind,
          cmd: () => {
            if (command.enabled === false) return false
            if (typeof command.enabled === "function" && !command.enabled()) return false
            return command.run()
          },
          ...(command.title === undefined && command.description === undefined
            ? {}
            : { desc: command.title ?? command.description }),
          ...(command.group === undefined ? {} : { group: command.group }),
        })),
        ...grouped.named.flatMap((command) => {
          if (command.bind === false) return []
          const overridden = fromFile(command.id)
          if (overridden) return overridden
          const configured = value.config.keybinds.get(command.id)
          if (configured.length) return configured
          if (typeof command.bind !== "string") return []
          return [{ key: command.bind, cmd: command.id }]
        }),
        ...(bindings ?? []).flatMap((id) => fromFile(id) ?? value.config.keybinds.get(id)),
      ],
    }
  })
}

function useShortcuts() {
  const value = useValue()
  const shortcuts = useKeymapSelector((keymap) => {
    const commands = keymap.getCommands({ visibility: "registered" }).map((command) => command.name)
    const bindings = keymap.getCommandBindings({ visibility: "registered", commands })
    return new Map(
      commands.map((id) => {
        const current = bindings.get(id) ?? []
        return [
          id,
          {
            first: formatKeySequence(current[0]?.sequence, formatOptions(value.config)),
            all: formatCommandBindings(current, formatOptions(value.config)),
            list: current
              .map((binding) => formatKeySequence(binding.sequence, formatOptions(value.config)))
              .filter((shortcut): shortcut is string => shortcut !== undefined),
          },
        ]
      }),
    )
  })
  return {
    get(id: string) {
      return shortcuts().get(id)?.first
    },
    all(id: string) {
      return shortcuts().get(id)?.all
    },
    list(id: string) {
      return shortcuts().get(id)?.list ?? []
    },
  }
}

function useShortcut(id: string) {
  const shortcuts = useShortcuts()
  return () => shortcuts.get(id)
}

function useLeaderActive() {
  const pending = usePendingSequence()
  return () => pending()[0]?.tokenName === "leader"
}

function useCommands(): Accessor<readonly KeymapCommand[]> {
  const value = useValue()
  return useKeymapSelector((keymap) =>
    keymap
      .getCommandEntries({
        visibility: "reachable",
      })
      .map((entry) => {
        const command = entry.command.orbit ?? {
          id: entry.command.name,
          title: typeof entry.command.title === "string" ? entry.command.title : undefined,
          description: typeof entry.command.desc === "string" ? entry.command.desc : undefined,
          group: typeof entry.command.category === "string" ? entry.command.category : undefined,
          enabled:
            typeof entry.command.enabled === "boolean" || typeof entry.command.enabled === "function"
              ? (entry.command.enabled as boolean | (() => boolean))
              : undefined,
          palette: entry.command.namespace === "palette" ? true : undefined,
          slash: entry.command.slash,
          suggested:
            typeof entry.command.suggested === "boolean" || typeof entry.command.suggested === "function"
              ? (entry.command.suggested as boolean | (() => boolean))
              : undefined,
        }
        return {
          ...command,
          run: (input?: string) => {
            value.dispatch(entry.command.name, input)
          },
        }
      }),
  )
}

function usePendingSequence() {
  useValue()
  return useKeymapSelector((keymap) => keymap.getPendingSequence())
}

function useActiveKeys() {
  useValue()
  return useKeymapSelector((keymap) => keymap.getActiveKeys({ includeMetadata: true }))
}

function useState() {
  const value = useValue()
  const commands = useCommands()
  const pending = usePendingSequence()
  const active = useActiveKeys()
  return {
    commands,
    pending: (): readonly KeymapPending[] =>
      pending().map((item) => ({
        key: formatKeySequence([item], formatOptions(value.config)) ?? "",
        ...(item.tokenName ? { token: item.tokenName } : {}),
      })),
    active: (): readonly KeymapActive[] =>
      active().map((item) => ({
        key:
          formatKeySequence(
            [{ stroke: item.stroke, display: item.display, tokenName: item.tokenName }],
            formatOptions(value.config),
          ) ?? "",
        ...(typeof item.commandAttrs?.title === "string" ? { title: item.commandAttrs.title } : {}),
        ...(typeof item.bindingAttrs?.desc === "string"
          ? { description: item.bindingAttrs.desc }
          : typeof item.commandAttrs?.desc === "string"
            ? { description: item.commandAttrs.desc }
            : {}),
        ...(typeof item.commandAttrs?.category === "string"
          ? { group: item.commandAttrs.category }
          : typeof item.bindingAttrs?.group === "string"
            ? { group: item.bindingAttrs.group }
            : {}),
        continues: item.continues,
      })),
  }
}

function useValue() {
  const value = useContext(Context)
  if (!value) throw new Error("Keymap.Provider is missing")
  return value
}

export const Keymap = {
  Provider,
  use,
  createLayer,
  useShortcuts,
  useShortcut,
  useLeaderActive,
  useCommands,
  usePendingSequence,
  useActiveKeys,
  useState,
} as const

function createMode(keymap: OpenTuiKeymap) {
  const [stack, setStack] = createSignal<
    { readonly id: symbol; readonly mode: string; readonly enabled: Accessor<boolean> }[]
  >([])
  const current = createMemo(() => stack().findLast((item) => item.enabled())?.mode ?? MODE.base)
  // Publish mode changes before another command can be dispatched in the same callback.
  createComputed(() => keymap.setData(MODE.key, current()))
  const unregister = keymap.registerLayerFields({
    mode(value, context) {
      context.require(MODE.key, value)
    },
  })
  let disposed = false

  return {
    current,
    push(mode: string, enabled: Accessor<boolean>) {
      if (disposed) return () => {}
      const id = Symbol(mode)
      // Inactive scopes retain their stack position beneath any newer modes.
      setStack((items) => [...items, { id, mode, enabled }])
      return () => {
        setStack((items) => items.filter((item) => item.id !== id))
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      setStack([])
      unregister()
      keymap.setData(MODE.key, undefined)
    },
  }
}

function formatOptions(config: KeymapConfig) {
  const leader = config.keybinds.get("leader")?.[0]?.key
  return {
    tokenDisplay: {
      leader: leader ? (typeof leader === "string" ? leader : stringifyKeyStroke(leader)) : TuiKeybind.LeaderDefault,
    },
    keyNameAliases: {
      up: "↑",
      down: "↓",
      left: "←",
      right: "→",
      pageup: "pgup",
      pagedown: "pgdn",
      delete: "del",
    },
    modifierAliases: {
      meta: "alt",
    },
  } as const
}
