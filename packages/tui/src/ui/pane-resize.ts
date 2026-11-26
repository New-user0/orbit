import { MouseButton, type MouseEvent } from "@opentui/core"
import { createEffect, createSignal } from "solid-js"

export function createPaneResize(options: {
  value: () => number
  defaultValue: () => number
  clamp: (size: number) => number
  fromMouse: (event: MouseEvent) => number
  contains: (event: MouseEvent, size: number) => boolean
  onCommit: (size: number) => void
  /**
   * The time, in milliseconds, that tells a double click from two clicks; the wall clock unless given. A test gives its
   * own, so a loaded machine that delivers the second press late does not turn the reset into a new drag.
   */
  now?: () => number
}) {
  const now = options.now ?? Date.now
  const [preferredSize, setPreferredSize] = createSignal(options.value())
  const [hovered, setHovered] = createSignal(false)
  const [resizing, setResizing] = createSignal(false)
  let requestedSize = options.value()
  createEffect(() => {
    if (resizing()) return
    requestedSize = options.value()
    setPreferredSize(requestedSize)
  })
  const size = () => options.clamp(preferredSize())
  const commit = (value: number) => {
    const next = options.clamp(value)
    setPreferredSize(next)
    if (requestedSize === next) return
    requestedSize = next
    options.onCommit(next)
  }
  let moved = false
  let lastBoundaryClick = 0
  const finish = (event: MouseEvent) => {
    if (!resizing()) return
    const next = moved ? options.fromMouse(event) : size()
    setResizing(false)
    lastBoundaryClick = moved ? 0 : now()
    commit(next)
    setHovered(options.contains(event, options.clamp(next)))
    event.stopPropagation()
  }

  // Bind drag/release on the parent so resizing continues outside the handle.
  return {
    preferredSize,
    size,
    hovered,
    resizing,
    onMouseOver: () => setHovered(true),
    onMouseOut: () => setHovered(false),
    onMouseDown: (event: MouseEvent) => {
      if (event.button !== MouseButton.LEFT) return
      if (now() - lastBoundaryClick < 300) {
        lastBoundaryClick = 0
        setResizing(false)
        setHovered(false)
        commit(options.defaultValue())
        event.preventDefault()
        event.stopPropagation()
        return
      }
      moved = false
      setResizing(true)
      event.preventDefault()
      event.stopPropagation()
    },
    onMouseDrag: (event: MouseEvent) => {
      if (!resizing()) return
      moved = true
      lastBoundaryClick = 0
      setPreferredSize(options.clamp(options.fromMouse(event)))
      event.stopPropagation()
    },
    onMouseDragEnd: finish,
    onMouseUp: finish,
  }
}
