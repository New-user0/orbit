/// <reference path="./audio.d.ts" />
import type {
  Attention,
  AttentionNotifyOptions,
  AttentionNotifyResult,
  AttentionNotifySkipReason,
  AttentionWhen,
  AttentionSoundName,
} from "@orbit/plugin/tui/context"
import { Config } from "./config"
import { Schema } from "effect"
import stripAnsi from "strip-ansi"
import * as TuiAudio from "./audio"
import { ringTerminalBell } from "./util/terminal-bell"
import {
  defaultSoundPath,
  questionSoundPath,
  permissionSoundPath,
  errorSoundPath,
  subagentDoneSoundPath,
} from "#attention-sounds"

type FocusState = "unknown" | "focused" | "blurred"

type AttentionRenderer = {
  readonly isDestroyed: boolean
  triggerNotification(message: string, title?: string): boolean
  idle(): Promise<void>
  readonly isRunning?: boolean
  on(event: "focus" | "blur" | "frame", listener: () => void): unknown
  off(event: "focus" | "blur" | "frame", listener: () => void): unknown
}

type AttentionHost = Attention & {
  dispose(): void
}

const DEFAULT_TITLE = "Orbit"
const TITLE_LIMIT = 80
const MESSAGE_LIMIT = 240
const BUILTIN_SOUNDS: Record<AttentionSoundName, string> = {
  default: defaultSoundPath,
  question: questionSoundPath,
  permission: permissionSoundPath,
  error: errorSoundPath,
  done: defaultSoundPath,
  subagent_done: subagentDoneSoundPath,
}

function skipped(reason: AttentionNotifySkipReason): AttentionNotifyResult {
  return {
    ok: false,
    notification: false,
    sound: false,
    skipped: reason,
  }
}

function normalizeText(input: string | undefined, fallback: string, limit: number) {
  const text = stripAnsi(input ?? "")
    .replace(/[ \t]*[\r\n]+[ \t]*/g, " ")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .trim()
  const normalized = text.length ? text : fallback
  return Array.from(normalized).slice(0, limit).join("")
}

function clampVolume(volume: number) {
  if (!Number.isFinite(volume)) return 0
  return Math.min(1, Math.max(0, volume))
}

function soundVolume(input: AttentionNotifyOptions, config: Pick<Config.Resolved, "attention">) {
  if (!config.attention.sound) return
  if (input.sound === false) return
  if (input.sound === undefined) return clampVolume(config.attention.volume)
  if (input.sound === true) return clampVolume(config.attention.volume)
  return clampVolume(input.sound.volume ?? config.attention.volume)
}

function focusSkip(when: AttentionWhen, focus: FocusState) {
  if (when === "always") return
  if (focus === "unknown") return "focus_unknown"
  if (when === "blurred" && focus === "focused") return "focused"
  if (when === "focused" && focus === "blurred") return "blurred"
}

export function createTuiAttention(input: {
  renderer: AttentionRenderer
  config: Pick<Config.Resolved, "attention">
  audio?: Pick<typeof TuiAudio, "loadSoundFile" | "play">
  /** Where the bell byte goes; defaults to the process stdout. */
  writeBell?: (text: string) => unknown
}): AttentionHost {
  let focus: FocusState = "unknown"
  let disposed = false
  const audio = input.audio ?? TuiAudio

  const onFocus = () => {
    focus = "focused"
  }
  const onBlur = () => {
    focus = "blurred"
  }

  input.renderer.on("focus", onFocus)
  input.renderer.on("blur", onBlur)

  function soundCandidates(name: AttentionSoundName) {
    return [input.config.attention.sounds[name], BUILTIN_SOUNDS[name]].filter(
      (item, index, list): item is string => typeof item === "string" && list.indexOf(item) === index,
    )
  }

  async function playSound(name: AttentionSoundName, volume: number) {
    try {
      for (const file of soundCandidates(name)) {
        const current = await audio.loadSoundFile(file).catch((error) => {
          console.debug("failed to load attention sound", { file, error })
          return null
        })
        if (disposed) return false
        if (current == null) continue
        if (audio.play(current, { volume }) != null) return true
      }
      return false
    } catch (error) {
      console.debug("failed to play attention sound", { error })
      return false
    }
  }

  return {
    get idleReminder() {
      return input.config.attention.idle_reminder
    },
    async notify(request) {
      try {
        if (!input.config.attention.notifications && !input.config.attention.sound && !input.config.attention.bell)
          return skipped("attention_disabled")
        if (disposed || input.renderer.isDestroyed) return skipped("renderer_destroyed")

        const message = normalizeText(request.message, "", MESSAGE_LIMIT)
        if (!message) return skipped("empty_message")

        const requestedNotification = typeof request.notification === "object" ? request.notification : undefined
        const notificationSkip = focusSkip(requestedNotification?.when ?? "blurred", focus)
        const notificationRequested = input.config.attention.notifications && request.notification !== false
        const shouldNotify = notificationRequested && !notificationSkip
        const notification = shouldNotify
          ? (() => {
              try {
                return input.renderer.triggerNotification(
                  message,
                  normalizeText(request.title, DEFAULT_TITLE, TITLE_LIMIT),
                )
              } catch (error) {
                console.debug("failed to trigger attention notification", { error })
                return false
              }
            })()
          : false
        const volume = soundVolume(request, input.config)
        const requestedSound = typeof request.sound === "object" ? request.sound : undefined
        const soundSkip = volume === undefined ? undefined : focusSkip(requestedSound?.when ?? "always", focus)
        const soundName =
          requestedSound?.name && Schema.is(Config.AttentionSoundName)(requestedSound.name)
            ? requestedSound.name
            : "default"
        const sound = volume === undefined || soundSkip ? false : await playSound(soundName, volume)

        // By default the bell also fires when focus is unknown; a request can ask for blurred only.
        const bellWhen = request.bell?.when
        const bellSkip =
          bellWhen === undefined ? (focus === "focused" ? "focused" : undefined) : focusSkip(bellWhen, focus)
        const bell =
          input.config.attention.bell && (request.bell !== undefined || request.notification !== false) && !bellSkip
            ? await ringTerminalBell(input.renderer, input.writeBell)
            : false

        if (!notification && !sound && !bell) {
          if (notificationRequested && notificationSkip) return skipped(notificationSkip)
          if (soundSkip) return skipped(soundSkip)
          if (input.config.attention.bell && bellSkip) return skipped(bellSkip)
        }

        return {
          ok: notification || sound || bell,
          notification,
          sound,
          bell,
        }
      } catch (error) {
        console.debug("failed to handle attention notification", { error })
        return {
          ok: false,
          notification: false,
          sound: false,
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      input.renderer.off("focus", onFocus)
      input.renderer.off("blur", onBlur)
    },
  }
}
