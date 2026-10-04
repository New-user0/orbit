import { createMemo } from "solid-js"
import type { SessionInfo } from "@orbit/client"
import { withTimestampedFallback } from "@orbit/util/session-title-fallback"
import { useData } from "../context/data"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { Locale } from "../util/locale"

/**
 * Every agent working for the current conversation, as a tree from the main session down through the subagents and
 * workflow agents it started. Running agents come first among siblings; selecting one opens its session.
 */
export function DialogAgentMap(props: { readonly sessionID: string }) {
  const data = useData()
  const route = useRoute()
  const dialog = useDialog()
  const root = () => data.session.root(props.sessionID)
  const sessions = createMemo(() =>
    [root(), ...data.session.family(root())]
      .flatMap((id) => {
        const info = data.session.get(id)
        return info ? [info] : []
      })
      .filter((info, index, all) => all.findIndex((other) => other.id === info.id) === index),
  )
  const rows = createMemo(() => {
    const running = (info: SessionInfo) => data.session.status(info.id) === "running"
    const children = (parentID: string) =>
      sessions()
        .filter((info) => info.parentID === parentID)
        .toSorted(
          (left, right) => Number(running(right)) - Number(running(left)) || left.time.created - right.time.created,
        )
    const walk = (info: SessionInfo, prefix: string, last: boolean, depth: number): ReturnType<typeof row>[] => {
      const below = children(info.id)
      const branch = depth === 0 ? "" : `${prefix}${last ? "└─ " : "├─ "}`
      const next = depth === 0 ? "" : `${prefix}${last ? "   " : "│  "}`
      return [
        row(info, branch, running(info)),
        ...below.flatMap((child, index) => walk(child, next, index === below.length - 1, depth + 1)),
      ]
    }
    const top = sessions().find((info) => info.id === root())
    return top ? walk(top, "", true, 0) : []
  })
  const count = () => Math.max(0, sessions().length - 1)

  return (
    <DialogSelect
      title="Agent map"
      placeholder={`${count()} agent${count() === 1 ? "" : "s"} · select one to open it`}
      current={props.sessionID}
      options={rows()}
      onSelect={(option) => {
        dialog.clear()
        route.navigate({ type: "session", sessionID: option.value })
      }}
    />
  )
}

function row(info: SessionInfo, branch: string, running: boolean) {
  const tokens = info.tokens.input + info.tokens.output + info.tokens.reasoning
  const elapsed = (running ? Date.now() : (info.time.idle ?? info.time.updated)) - info.time.created
  return {
    value: info.id,
    title: `${branch}${running ? "●" : "○"} ${withTimestampedFallback(info)}`,
    description: [
      info.model?.id,
      Locale.duration(Math.max(0, elapsed)),
      tokens > 0 ? `${Locale.number(tokens)} tokens` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    searchText: withTimestampedFallback(info),
  }
}
