import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, Show } from "solid-js"
import { plain } from "@orbit/flow/plain"
import { withTimestampedFallback } from "@orbit/util/session-title-fallback"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useLocal } from "../context/local"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { useTuiApp, useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { abbreviateHome } from "../runtime"
import { mark } from "../logo"

/** Below these sizes the banner shrinks to one line, so small terminals keep their rows for the conversation. */
export const BANNER_FULL = { width: 64, height: 24 }

/**
 * The banner pinned to the top of every screen: the mark, the version, where Orbit is working, and on the right the
 * session and model. It shows only facts the user cannot see elsewhere at a glance.
 */
export function Banner() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const app = useTuiApp()
  const paths = useTuiPaths()
  const data = useData()
  const local = useLocal()
  const route = useRoute()
  const current = useLocation()
  const shortcuts = Keymap.useShortcuts()

  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const location = createMemo(() => {
    const id = sessionID()
    return (id ? data.session.get(id)?.location : undefined) ?? current.ref ?? data.location.default()
  })
  const where = createMemo(() => {
    const value = location()
    if (!value) return ""
    const directory = abbreviateHome(value.directory, paths.home)
    const branch = data.location.vcs.info(value)?.branch.current
    return branch ? `${directory} · ⎇ ${branch}` : directory
  })
  const title = createMemo(() => {
    const id = sessionID()
    if (!id) return "new session"
    const session = data.session.get(id)
    return session ? plain(withTimestampedFallback(session)) : ""
  })
  const model = () => local.model.parsed().model
  const commands = () => shortcuts.get("command.palette.show")
  const full = () => dimensions().width >= BANNER_FULL.width && dimensions().height >= BANNER_FULL.height
  const version = () => (app.version.startsWith("v") ? app.version : `v${app.version}`)

  return (
    <Show
      when={full()}
      fallback={
        <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} gap={1}>
          <text fg={theme.brand.base} attributes={TextAttributes.BOLD} selectable={false}>
            {mark.compact}
          </text>
          <text fg={theme.brand.base} attributes={TextAttributes.BOLD} selectable={false}>
            Orbit
          </text>
          <text fg={theme.text.muted} wrapMode="none" flexShrink={1}>
            {where()}
          </text>
          <box flexGrow={1} />
          <text fg={theme.text.muted} wrapMode="none" flexShrink={0}>
            {model()}
          </text>
        </box>
      }
    >
      <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
        <box
          border
          borderStyle="rounded"
          borderColor={theme.brand.base}
          flexDirection="row"
          alignItems="center"
          gap={2}
          paddingLeft={2}
          paddingRight={2}
        >
          <box flexShrink={0}>
            <text fg={theme.brand.base} selectable={false}>
              {mark.top}
            </text>
            <text selectable={false}>
              <span style={{ fg: theme.text.muted }}>{mark.ring}</span>
              <span style={{ fg: theme.brand.base }}>{mark.planet}</span>
              <span style={{ fg: theme.text.muted }}>{mark.ring}</span>
              <span style={{ fg: theme.text.base }}>{mark.moon}</span>
            </text>
            <text fg={theme.brand.base} selectable={false}>
              {mark.bottom}
            </text>
          </box>
          <box flexShrink={1} minWidth={0}>
            <text wrapMode="none">
              <span style={{ fg: theme.brand.base, attributes: TextAttributes.BOLD }}>Orbit</span>
              <span style={{ fg: theme.text.muted }}>{`  ${version()}`}</span>
            </text>
            <text fg={theme.text.muted} wrapMode="none">
              {where()}
            </text>
          </box>
          <box flexGrow={1} />
          <box flexShrink={1} minWidth={0} alignItems="flex-end">
            <text fg={theme.text.base} wrapMode="none">
              {title()}
            </text>
            <text wrapMode="none">
              <span style={{ fg: theme.text.muted }}>{model()}</span>
              <Show when={commands()}>
                {(key) => (
                  <>
                    <span style={{ fg: theme.text.muted }}> · </span>
                    <span style={{ fg: theme.brand.base }}>{`${key()} commands`}</span>
                  </>
                )}
              </Show>
            </text>
          </box>
        </box>
      </box>
    </Show>
  )
}
