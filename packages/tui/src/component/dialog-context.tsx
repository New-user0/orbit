import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { OrbitClient } from "@orbit/client"
import { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { plain } from "@orbit/util/plain"
import { Option, Schema } from "effect"
import { createMemo, createResource, For, Show } from "solid-js"
import { useClient } from "../context/client"
import { useData } from "../context/data"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { contextSuggestions } from "../util/context-suggestions"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import { formatPath } from "../util/path-format"

// `/context`: the server's estimate of what the session's next request carries, drawn as the reference draws its own,
// with a square grid beside a legend, the lists a person can act on, and suggestions. The server answers only for a main
// session in a trusted folder; every string it sends is a file's, a config's or a tool server's, so each is drawn through
// `plain` (class 9) and is only ever text (class 5).

const TIMEOUT = 30_000
const FULL = "■"
const PARTIAL = "▪"
const FREE = "□"
const BUFFER = "▣"
// A square at least this full is drawn whole; a fuller share than nothing but less than this takes the lighter glyph.
const WHOLE = 0.7
const WIDE = 1_000_000
const NARROW = 80

const LABELS: Record<SessionContextUsage.CategoryKind, string> = {
  system: "System prompt",
  tools: "System tools",
  mcp: "MCP tools",
  "mcp-deferred": "MCP tools (deferred)",
  "tools-deferred": "System tools (deferred)",
  agents: "Custom agents",
  instructions: "Instruction files",
  skills: "Skills",
  messages: "Messages",
  "auto-buffer": "Autocompact buffer",
  "compact-buffer": "Compact buffer",
  free: "Free space",
}
const DEFERRED = new Set<SessionContextUsage.CategoryKind>(["mcp-deferred", "tools-deferred"])
const RESERVE = new Set<SessionContextUsage.CategoryKind>(["auto-buffer", "compact-buffer"])
const SCOPES = ["project", "local", "user", "flag", "managed", "remote"]

type Answer = { readonly info: SessionContextUsage.Info } | { readonly error: string }
type Square = { readonly kind: SessionContextUsage.CategoryKind; readonly whole: boolean }

/** /context for the session in view. A child's context is its main session's, so the dialog asks for that one (D8). */
export function DialogContext(props: { readonly sessionID: string; readonly timeout?: number }) {
  const client = useClient()
  const data = useData()
  const theme = useTheme()

  // The session's main session, by its parents. A chain that comes back to a session already seen stops there.
  const rootOf = async (sessionID: string, seen: ReadonlySet<string>): Promise<string> => {
    const info =
      data.session.get(sessionID) ??
      (await data.session.sync(sessionID).then(
        () => data.session.get(sessionID),
        () => undefined,
      ))
    const parent = info?.parentID
    if (!parent || seen.has(parent)) return sessionID
    return rootOf(parent, new Set([...seen, sessionID]))
  }
  const [answer] = createResource(
    () => props.sessionID,
    async (sessionID) =>
      readContextUsage(client.api, await rootOf(sessionID, new Set([sessionID])), props.timeout ?? TIMEOUT),
  )

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
        Context usage
      </text>
      <Show when={answer()} fallback={<text fg={theme.text.muted}>Measuring the context…</text>}>
        {(value) => {
          const current = value()
          if ("error" in current) return <text fg={theme.text.feedback.error.base}>{current.error}</text>
          return <ContextView info={current.info} directory={data.session.get(props.sessionID)?.location.directory} />
        }}
      </Show>
    </box>
  )
}

/**
 * Asks the server for a session's context usage, and turns each way it can fail into one line a person can read: the
 * server's own refusal (an untrusted folder, a child session, a missing session or model), a server older than the
 * route, an answer that is not the payload, and no answer in time (classes 7 and 13).
 */
async function readContextUsage(api: OrbitClient, sessionID: string, timeout: number): Promise<Answer> {
  const signal = AbortSignal.timeout(timeout)
  const expired = new Promise<never>((_, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
  )
  return Promise.race([api.session.contextUsage({ sessionID }, { signal }), expired]).then(
    (value) =>
      Option.match(Schema.decodeUnknownOption(SessionContextUsage.Info)(value), {
        onNone: () => ({ error: "The server's answer about context usage could not be read." }),
        onSome: (info) => ({ info }),
      }),
    (error: unknown) => ({ error: failure(error) }),
  )
}

function failure(error: unknown) {
  const named = (value: unknown, name: string) =>
    typeof value === "object" && value !== null && "name" in value && value.name === name
  if (named(error, "TimeoutError") || (error instanceof Error && named(error.cause, "TimeoutError")))
    return "The server did not answer in time."
  // A typed refusal: the server's message, which names the folder or the session.
  if (typeof error === "object" && error !== null && "_tag" in error) return plain(errorMessage(error))
  // A server from before the route answers 404 with no body. The route declares 404, so the client reads that body as
  // a typed error and finds no content type.
  if (error instanceof Error && error.name === "ClientError" && error.message === "UnsupportedContentType")
    return "The server is older than this client and does not report context usage."
  return plain(`Could not read context usage: ${errorMessage(error)}`)
}

/** The view of one answer, apart from the request so that a story can draw it from a fixture. */
export function ContextView(props: { readonly info: SessionContextUsage.Info; readonly directory?: string }) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const paths = useTuiPaths()
  const window = () => (props.info.window === undefined || props.info.window === 0 ? undefined : props.info.window)
  const percent = (tokens: number) => {
    const known = window()
    return known === undefined ? "" : ` (${((tokens / known) * 100).toFixed(1)}%)`
  }
  // Counted categories take the theme's series colours in their order; free space and the buffers are muted.
  const colors = createMemo(() => {
    const counted = props.info.categories.filter(
      (item) => item.kind !== "free" && item.kind !== "auto-buffer" && item.kind !== "compact-buffer" && !DEFERRED.has(item.kind),
    )
    return new Map(counted.map((item, index) => [item.kind, theme.categorical[index % theme.categorical.length]![200]]))
  })
  const color = (kind: SessionContextUsage.CategoryKind) => colors().get(kind) ?? theme.text.muted
  const glyph = (square: Square) =>
    square.kind === "free" ? FREE : square.kind === "auto-buffer" ? BUFFER : square.whole ? FULL : PARTIAL
  const rows = createMemo(() => {
    const known = window()
    return known === undefined ? [] : grid(props.info.categories, known, dimensions().width < NARROW)
  })
  const legend = createMemo(() =>
    props.info.categories.filter((item) => item.tokens > 0 && item.kind !== "free" && item.kind !== "auto-buffer"),
  )
  // Free space, then the autocompact buffer, as the reference lists them under the categories.
  const tail = createMemo(() =>
    (["free", "auto-buffer"] as const).flatMap((kind) =>
      props.info.categories.filter((item) => item.kind === kind && item.tokens > 0),
    ),
  )
  const model = () => plain(`${props.info.model.providerID}/${props.info.model.id}`)
  const summary = () => {
    const known = window()
    const total = Locale.number(props.info.total)
    if (known === undefined) return `${model()} · ${total} tokens`
    return `${model()} · ${total}/${Locale.number(known)} tokens (${props.info.percentage ?? 0}%)`
  }
  const loaded = () => props.info.mcp.filter((tool) => !tool.deferred)
  const available = () => props.info.mcp.filter((tool) => tool.deferred)
  const groups = createMemo(() => {
    const scopes = [...new Set(props.info.agents.map((agent) => agent.scope))].toSorted(
      (a, b) => rank(a) - rank(b) || a.localeCompare(b),
    )
    return scopes.map((scope) => ({
      scope: SCOPES.includes(scope) ? `${scope[0]!.toUpperCase()}${scope.slice(1)}` : plain(scope),
      agents: props.info.agents.filter((agent) => agent.scope === scope).toSorted((a, b) => b.tokens - a.tokens),
    }))
  })
  const display = (file: string) =>
    plain(props.directory === undefined ? file : formatPath(file, { base: props.directory, home: paths.home }))
  const suggestions = createMemo(() => contextSuggestions(props.info))

  return (
    <box gap={1}>
      <box flexDirection="row" gap={3}>
        <Show when={rows().length > 0}>
          <box flexShrink={0}>
            <For each={rows()}>
              {(row) => (
                <text>
                  <For each={row}>
                    {(square, index) => (
                      <span style={{ fg: square.kind === "free" ? theme.text.muted : color(square.kind) }}>
                        {glyph(square) + (index() < row.length - 1 ? " " : "")}
                      </span>
                    )}
                  </For>
                </text>
              )}
            </For>
          </box>
        </Show>
        <box flexShrink={1}>
          <text fg={theme.text.muted}>{summary()}</text>
          <text fg={theme.text.muted} attributes={TextAttributes.ITALIC}>
            Estimated usage by category
          </text>
          <For each={legend()}>
            {(item) => (
              <text fg={theme.text.base}>
                <span style={{ fg: color(item.kind) }}>{DEFERRED.has(item.kind) ? " " : FULL}</span>
                {` ${LABELS[item.kind]}: `}
                <span style={{ fg: theme.text.muted }}>
                  {`${Locale.number(item.tokens)} tokens${DEFERRED.has(item.kind) ? (window() === undefined ? "" : " (N/A)") : percent(item.tokens)}`}
                </span>
              </text>
            )}
          </For>
          <For each={tail()}>
            {(item) => (
              <text fg={theme.text.base}>
                <span style={{ fg: theme.text.muted }}>{item.kind === "free" ? FREE : BUFFER}</span>
                {` ${LABELS[item.kind]}: `}
                <span style={{ fg: theme.text.muted }}>{`${Locale.number(item.tokens)} tokens${percent(item.tokens)}`}</span>
              </text>
            )}
          </For>
        </box>
      </box>
      <Show when={props.info.mcp.length > 0}>
        <box>
          <Heading title="MCP tools" command="/mcps" />
          {/* The two groups are named only when some tools are deferred; otherwise every tool is a loaded one. */}
          <Show when={available().length > 0 && loaded().length > 0}>
            <text fg={theme.text.muted}>Loaded</text>
          </Show>
          <For each={loaded()}>
            {(tool) => <Item text={`${plain(tool.name)} (${plain(tool.server)}): ${Locale.number(tool.tokens)} tokens`} />}
          </For>
          <Show when={available().length > 0}>
            <text fg={theme.text.muted}>Available</text>
            <For each={available()}>{(tool) => <Item text={`${plain(tool.name)} (${plain(tool.server)})`} />}</For>
          </Show>
        </box>
      </Show>
      <Show when={groups().length > 0}>
        <box>
          <Heading title="Custom agents" command="/agents" />
          <For each={groups()}>
            {(group) => (
              <>
                <text fg={theme.text.muted}>{group.scope}</text>
                <For each={group.agents}>
                  {(agent) => <Item text={`${plain(agent.id)}: ${Locale.number(agent.tokens)} tokens`} />}
                </For>
              </>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.info.files.length > 0}>
        <box>
          <Heading title="Instruction files" command="/memory" />
          <For each={props.info.files}>
            {(file) => <Item text={`${display(file.path)}: ${Locale.number(file.tokens)} tokens`} />}
          </For>
        </box>
      </Show>
      <Show when={props.info.skills.length > 0}>
        <box>
          <Heading title="Skills" command="/skills" />
          <For each={props.info.skills}>
            {(skill) => <Item text={`${plain(skill.id)}: ${Locale.number(skill.tokens)} tokens`} />}
          </For>
        </box>
      </Show>
      <Show when={suggestions().length > 0}>
        <box>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            Suggestions
          </text>
          <For each={suggestions()}>
            {(suggestion) => (
              <box>
                <text fg={theme.text.base}>
                  <span
                    style={{
                      fg:
                        suggestion.severity === "warning"
                          ? theme.text.feedback.warning.base
                          : theme.text.feedback.info.base,
                    }}
                  >
                    {suggestion.severity === "warning" ? "!" : "i"}
                  </span>
                  <span style={{ attributes: TextAttributes.BOLD }}>{` ${suggestion.title}`}</span>
                  <Show when={suggestion.savings}>
                    {(savings) => (
                      <span style={{ fg: theme.text.muted }}>{` · saves about ${Locale.number(savings())} tokens`}</span>
                    )}
                  </Show>
                </text>
                <text fg={theme.text.muted}>{`  ${suggestion.detail}`}</text>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function Heading(props: { readonly title: string; readonly command: string }) {
  const theme = useTheme()
  return (
    <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
      {props.title}
      <span style={{ fg: theme.text.muted }}>{` · ${props.command}`}</span>
    </text>
  )
}

function Item(props: { readonly text: string }) {
  const theme = useTheme()
  return <text fg={theme.text.base}>{`└ ${props.text}`}</text>
}

const rank = (scope: string) => {
  const index = SCOPES.indexOf(scope)
  return index === -1 ? SCOPES.length : index
}

/**
 * The reference's grid: 10 by 10 squares, 20 by 10 for a window of a million tokens or more, and 5 by 5 or 5 by 10
 * below 80 columns. Each counted category takes its share of the squares and one at least, in order; the square its
 * share ends in is drawn lighter when it is less than 70% full. Free space fills the middle, and the reserve (either
 * buffer) the end. Deferred categories are in no sum, so they take no square.
 */
export function grid(categories: ReadonlyArray<SessionContextUsage.Category>, window: number, narrow: boolean) {
  const columns = narrow ? 5 : window >= WIDE ? 20 : 10
  const height = window >= WIDE || !narrow ? 10 : 5
  const total = columns * height
  const squares = (category: SessionContextUsage.Category): Square[] => {
    const exact = (category.tokens / window) * total
    const last = Math.floor(exact)
    const filled = exact - last
    return Array.from({ length: Math.max(1, Math.round(exact)) }, (_, index) => ({
      kind: category.kind,
      whole: index !== last || filled === 0 || filled >= WHOLE,
    }))
  }
  const counted = categories.filter((item) => item.tokens > 0 && item.kind !== "free" && !DEFERRED.has(item.kind))
  const body = counted.filter((item) => !RESERVE.has(item.kind)).flatMap(squares)
  const reserve = counted.filter((item) => RESERVE.has(item.kind)).flatMap(squares)
  const free = Array.from({ length: Math.max(0, total - body.length - reserve.length) }, () => ({
    kind: "free" as const,
    whole: true,
  }))
  const all = [...body, ...free, ...reserve].slice(0, total)
  return Array.from({ length: height }, (_, row) => all.slice(row * columns, (row + 1) * columns))
}
