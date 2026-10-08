import path from "path"
import fuzzysort from "fuzzysort"
import { onMount } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { PromptInput } from "@orbit/schema"
import type { Types } from "effect"
import { createSimpleContext } from "../context/helper"
import { useConfig } from "../config"
import { useTuiPaths } from "../context/runtime"
import { appendText, readText, writeText } from "../util/persistence"
import { promptOffsetWidth } from "./display"

export type PastedText = {
  text: string
  source: {
    start: number
    end: number
    text: string
  }
}

export type PromptInfo = Types.DeepMutable<Pick<PromptInput.Prompt, "text" | "files" | "agents" | "skills">> & {
  pasted: PastedText[]
  mode?: "normal" | "shell"
  /** Where the prompt was sent from. Missing on entries saved before history search. */
  directory?: string
  /** When the prompt was saved, in epoch milliseconds. Missing on entries saved before history search. */
  time?: number
}

export type PromptPartRef = {
  type: "file" | "agent" | "skill" | "pasted"
  index: number
}

export const emptyPrompt = (): PromptInfo => ({ text: "", files: [], agents: [], skills: [], pasted: [] })

// Part ranges are textarea offsets, so shift by display width rather than string length.
export function appendPrompt(prompt: PromptInfo, following: PromptInfo): PromptInfo {
  const text = prompt.text ? `${prompt.text}\n\n` : ""
  const offset = promptOffsetWidth(text)
  const shift = <T extends { start: number; end: number }>(range: T, by: number) => ({
    ...range,
    start: range.start + by,
    end: range.end + by,
  })
  const mentions = <T extends { mention?: { start: number; end: number } }>(
    items: T[] | undefined,
    next: T[] | undefined,
  ) => [
    ...(items ?? []).map((item) => ({ ...item, mention: item.mention && shift(item.mention, 0) })),
    ...(next ?? []).map((item) => ({ ...item, mention: item.mention && shift(item.mention, offset) })),
  ]
  return {
    text: text + following.text,
    files: mentions(prompt.files, following.files),
    agents: mentions(prompt.agents, following.agents),
    skills: mentions(prompt.skills, following.skills),
    pasted: [
      ...prompt.pasted.map((part) => ({ ...part, source: shift(part.source, 0) })),
      ...following.pasted.map((part) => ({ ...part, source: shift(part.source, offset) })),
    ],
  }
}

export const DEFAULT_HISTORY_LIMIT = 500
/** The saved file is trimmed from its oldest end to stay under this many bytes. */
export const MAX_HISTORY_BYTES = 1024 * 1024
/** A pasted body larger than this is not saved. */
export const MAX_SAVED_PASTE_BYTES = 4096
export const PASTE_NOT_SAVED = "[Pasted text was too large to keep in prompt history]"

/**
 * The form of an entry that is written to disk. Pasted images are base64 data URIs and large pastes are whole files,
 * so neither is saved: an image attachment is dropped (its mention stays in the text as plain words) and a large pasted
 * body is replaced by a notice. The entries in memory keep their originals for the session.
 */
export function savedEntry(entry: PromptInfo): PromptInfo {
  return {
    ...entry,
    files: entry.files?.filter((file) => !file.uri.startsWith("data:")),
    pasted: entry.pasted.map((part) =>
      Buffer.byteLength(part.text) > MAX_SAVED_PASTE_BYTES ? { ...part, text: PASTE_NOT_SAVED } : part,
    ),
  }
}

/** The newest entries that fit the count limit and the byte cap, as the lines of the history file. */
export function savedLines(entries: PromptInfo[], limit = DEFAULT_HISTORY_LIMIT) {
  const kept = entries.slice(-limit).map((entry) => JSON.stringify(savedEntry(entry)))
  let bytes = 0
  const lines: string[] = []
  for (const line of kept.toReversed()) {
    const size = Buffer.byteLength(line) + 1
    // An entry that is over the cap by itself is dropped, so that it cannot take every older entry with it.
    if (size > MAX_HISTORY_BYTES) continue
    if (bytes + size > MAX_HISTORY_BYTES) break
    bytes += size
    lines.push(line)
  }
  return lines.toReversed()
}

export function parsePromptHistory(text: string, limit = DEFAULT_HISTORY_LIMIT) {
  const entries = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return parsePromptInfo(JSON.parse(line))
      } catch {
        return undefined
      }
    })
    .filter((line): line is PromptInfo => line !== undefined)
  return savedLines(entries, limit).map((line) => JSON.parse(line) as PromptInfo)
}

/**
 * The entries whose text matches the query, best place first: those sent from the given directory, then the closest
 * match, then the newest.
 * Without a query every entry matches. The same prompt sent twice shows once, in its best place.
 */
export function searchPromptHistory(entries: readonly PromptInfo[], query: string, directory?: string) {
  const all = entries.map((entry, index) => ({ entry, index, score: 0 }))
  const matched = query.trim()
    ? fuzzysort
        .go(query.trim(), all, { key: (item) => item.entry.text })
        .map((result) => ({ ...result.obj, score: result.score }))
    : all
  const here = (entry: PromptInfo) => (directory !== undefined && entry.directory === directory ? 0 : 1)
  const seen = new Set<string>()
  return matched
    .toSorted((a, b) => here(a.entry) - here(b.entry) || b.score - a.score || b.index - a.index)
    .map((item) => item.entry)
    .filter((entry) => {
      const key = `${entry.mode ?? "normal"}\n${entry.text}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function isDuplicateEntry(previous: PromptInfo | undefined, next: PromptInfo): boolean {
  if (!previous) return false
  return JSON.stringify({ ...previous, time: 0 }) === JSON.stringify({ ...next, time: 0 })
}

export function parsePromptInfo(value: unknown): PromptInfo | undefined {
  if (!value || typeof value !== "object") return
  const input = value as Record<string, unknown>
  if (typeof input.text !== "string" || !Array.isArray(input.pasted)) return
  if (!input.pasted.every(isPastedText)) return
  if (input.files !== undefined && !(Array.isArray(input.files) && input.files.every(isFilePart))) return
  return input as PromptInfo
}

function isPastedText(value: unknown) {
  if (!value || typeof value !== "object") return false
  const part = value as { text?: unknown; source?: unknown }
  return typeof part.text === "string" && !!part.source && typeof part.source === "object"
}

function isFilePart(value: unknown) {
  return !!value && typeof value === "object" && typeof (value as { uri?: unknown }).uri === "string"
}

export const { use: usePromptHistory, provider: PromptHistoryProvider } = createSimpleContext({
  name: "PromptHistory",
  init: () => {
    const paths = useTuiPaths()
    const historyPath = path.join(paths.state, "prompt-history.jsonl")
    const config = useConfig().data
    const limit = () => config.prompt?.history_limit ?? DEFAULT_HISTORY_LIMIT
    // The size of the history file, so that an append knows when the file has outgrown its cap.
    let fileBytes = 0
    onMount(async () => {
      const lines = parsePromptHistory(await readText(historyPath).catch(() => ""), limit())
      setStore("history", lines)

      // Rewrite valid retained entries to self-heal corruption and enforce the limits.
      if (lines.length > 0) rewrite(lines)
    })

    const [store, setStore] = createStore({ index: 0, history: [] as PromptInfo[] })

    function rewrite(entries: PromptInfo[]) {
      const lines = savedLines(entries, limit())
      const content = lines.map((line) => line + "\n").join("")
      fileBytes = Buffer.byteLength(content)
      writeText(historyPath, content).catch(() => {})
    }

    return {
      entries: () => store.history,
      search: (query: string, directory?: string) => searchPromptHistory(store.history, query, directory),
      move(direction: 1 | -1, input: string) {
        if (!store.history.length) return undefined
        const current = store.history.at(store.index)
        if (!current) return undefined
        if (current.text !== input && input.length) return
        const next = store.index + direction
        if (Math.abs(next) > store.history.length || next > 0) return
        setStore("index", next)
        if (next === 0) return emptyPrompt()
        return store.history.at(next)
      },
      append(item: PromptInfo, directory?: string) {
        const entry = { ...structuredClone(unwrap(item)), directory, time: Date.now() }
        // Time is not part of what makes a prompt a repeat.
        if (isDuplicateEntry(store.history.at(-1), entry)) {
          setStore("index", 0)
          return
        }
        let trimmed = false
        setStore(
          produce((draft) => {
            draft.history.push(entry)
            if (draft.history.length > limit()) {
              draft.history = draft.history.slice(-limit())
              trimmed = true
            }
            draft.index = 0
          }),
        )

        const line = JSON.stringify(savedEntry(entry)) + "\n"
        fileBytes += Buffer.byteLength(line)
        if (trimmed || fileBytes > MAX_HISTORY_BYTES) {
          rewrite(store.history)
          return
        }
        appendText(historyPath, line).catch(() => {})
      },
    }
  },
})
