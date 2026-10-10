import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import Notifications from "../../../../src/feature-plugins/system/notifications"
import { createTuiAttention } from "../../../../src/attention"
import type { OrbitEvent, PermissionAsked } from "@orbit/client"
import type { AttentionNotifyOptions, Context, Route, ToastOptions } from "@orbit/plugin/tui/context"

type Session = { id: string; title: string; parentID?: string }

async function setup(
  route: Route = { type: "session", sessionID: "session" },
  idleReminder = 0,
  realAttention?: Context["attention"],
) {
  const keys = new EventEmitter()
  const notifications: AttentionNotifyOptions[] = []
  const toasts: ToastOptions[] = []
  const handlers = new Map<OrbitEvent["type"], ((event: OrbitEvent) => void)[]>()
  const session = (id: string, title: string, parentID?: string): Session => ({
    id,
    title,
    ...(parentID && { parentID }),
  })
  const sessions: Record<string, Session> = {
    session: session("session", "Demo session"),
    subagent: session("subagent", "Subagent session", "session"),
    abort: session("abort", "Abort session"),
    timeout: session("timeout", "Timeout session"),
  }

  await Notifications.setup({
    ui: {
      router: { current: () => route },
      toast: { show: (toast: ToastOptions) => toasts.push(toast) },
    },
    renderer: { keyInput: keys },
    attention: realAttention ?? {
      idleReminder,
      async notify(input: AttentionNotifyOptions) {
        notifications.push(input)
        return { ok: true, notification: true, sound: true }
      },
    },
    data: {
      on: <Type extends OrbitEvent["type"]>(
        type: Type,
        handler: (event: Extract<OrbitEvent, { type: Type }>) => void,
      ) => {
        const list = handlers.get(type) ?? []
        const wrapped = handler as (event: OrbitEvent) => void
        list.push(wrapped)
        handlers.set(type, list)
        return () => {
          handlers.set(
            type,
            (handlers.get(type) ?? []).filter((item) => item !== wrapped),
          )
        }
      },
      session: {
        get: (sessionID: string) => sessions[sessionID],
        status: () => "running" as const,
      },
    },
  } as unknown as Context)

  return {
    notifications,
    keys,
    toasts,
    emit(event: OrbitEvent) {
      for (const handler of handlers.get(event.type) ?? []) handler(event)
    },
  }
}

function form(id: string, sessionID = "session"): Extract<OrbitEvent, { type: "form.created" }>["data"]["form"] {
  return {
    id,
    sessionID,
    title: "Input requested",
    fields: [{ key: "authorization", type: "external", url: "https://example.com" }],
  }
}

function permission(id: string, sessionID = "session"): PermissionAsked["data"] {
  return {
    id,
    sessionID,
    action: "edit",
    resources: [],
    metadata: {},
    save: [],
  }
}

function durable(sessionID: string): { aggregateID: string; seq: number; version: 1 } {
  return { aggregateID: sessionID, seq: 0, version: 1 }
}

function executionStarted(id: string, sessionID = "session"): OrbitEvent {
  return {
    id,
    created: 0,
    type: "session.execution.started",
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function executionSucceeded(id: string, sessionID = "session"): OrbitEvent {
  return {
    id,
    created: 0,
    type: "session.execution.succeeded",
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function executionFailed(id: string, sessionID = "session"): OrbitEvent {
  return {
    id,
    created: 0,
    type: "session.execution.failed",
    durable: durable(sessionID),
    data: {
      sessionID,
      error: { type: "unknown", message: "boom" },
    },
  }
}

const formNotification: AttentionNotifyOptions = {
  title: "Input requested",
  message: "Input needs response",
  notification: { when: "blurred" },
  sound: { name: "question", when: "always" },
}

const titledFormNotification: AttentionNotifyOptions = {
  ...formNotification,
  title: "Confirm deployment",
}

const globalFormNotification: AttentionNotifyOptions = {
  ...formNotification,
  title: "demo-mcp is requesting input",
}

const permissionNotification: AttentionNotifyOptions = {
  title: "Demo session",
  message: "Permission needs input",
  notification: { when: "blurred" },
  sound: { name: "permission", when: "always" },
}

describe("internal notifications TUI plugin", () => {
  test("shows execution failures as session-scoped toasts without needing an assistant message", async () => {
    const harness = await setup()
    harness.emit(executionStarted("started"))
    harness.emit(executionFailed("failed"))
    harness.emit(executionFailed("duplicate"))
    expect(harness.toasts).toEqual([
      { sessionID: "session", title: "Session failed", message: "boom", variant: "error" },
    ])
    harness.emit(executionStarted("retry"))
    harness.emit(executionFailed("failed-again"))
    expect(harness.toasts).toHaveLength(2)
  })

  test.each<Route>([{ type: "home" }, { type: "session", sessionID: "other" }])(
    "leaves routing of other sessions' failures to the session-scoped toast (%j)",
    async (route) => {
      const harness = await setup(route)
      harness.emit(executionFailed("failed"))
      expect(harness.toasts).toEqual([
        { sessionID: "session", title: "Session failed", message: "boom", variant: "error" },
      ])
      expect(harness.notifications).toHaveLength(1)
    },
  )

  test("notifies for form and permission requests with blurred notifications and always-on sounds", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1"), title: "Confirm deployment" } },
    })
    harness.emit({ id: "event-3", created: 0, type: "permission.asked", data: permission("permission-1") })

    expect(harness.notifications).toEqual([titledFormNotification, permissionNotification])
  })

  test("notifies for global forms once the TUI can render them", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1", "global"), title: "demo-mcp is requesting input" } },
    })

    expect(harness.notifications).toEqual([globalFormNotification])
  })

  test("dedupes pending forms and permissions until they are resolved", async () => {
    const harness = await setup()

    harness.emit({ id: "event-1", created: 0, type: "form.created", data: { form: form("form-1") } })
    harness.emit({ id: "event-2", created: 0, type: "form.created", data: { form: form("form-1") } })
    harness.emit({
      id: "event-3",
      created: 0,
      type: "form.cancelled",
      data: { sessionID: "session", id: "form-1" },
    })
    harness.emit({ id: "event-4", created: 0, type: "form.created", data: { form: form("form-1") } })

    harness.emit({ id: "event-9", created: 0, type: "permission.asked", data: permission("permission-1") })
    harness.emit({ id: "event-10", created: 0, type: "permission.asked", data: permission("permission-1") })
    harness.emit({
      id: "event-11",
      created: 0,
      type: "permission.replied",
      data: { sessionID: "session", requestID: "permission-1", reply: "once" },
    })
    harness.emit({ id: "event-12", created: 0, type: "permission.asked", data: permission("permission-1") })

    expect(harness.notifications).toEqual([
      formNotification,
      formNotification,
      permissionNotification,
      permissionNotification,
    ])
  })

  test("notifies for terminal lifecycle events even when attached after execution started", async () => {
    const harness = await setup()

    harness.emit(executionSucceeded("event-1"))
    harness.emit(executionStarted("event-2"))
    harness.emit(executionSucceeded("event-3"))

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
      {
        title: "Demo session",
        message: "Session done",
        notification: { when: "blurred" },
        sound: { name: "done", when: "always" },
      },
    ])
  })

  test("uses sound-only notifications and subagent_done sound for subagent sessions", async () => {
    const harness = await setup()

    harness.emit({
      id: "event-1",
      created: 0,
      type: "form.created",
      data: { form: { ...form("form-1", "subagent"), title: "Questions" } },
    })
    harness.emit(executionStarted("event-2", "subagent"))
    harness.emit(executionSucceeded("event-3", "subagent"))

    expect(harness.notifications).toEqual([
      {
        title: "Questions",
        message: "Input needs response",
        notification: false,
        bell: {},
        sound: { name: "question", when: "always" },
      },
      {
        title: "Subagent session",
        message: "Session done",
        notification: false,
        sound: { name: "subagent_done", when: "always" },
      },
    ])
  })

  test("notifies session errors once and suppresses the following idle done notification", async () => {
    const harness = await setup()

    harness.emit(executionStarted("event-1"))
    harness.emit(executionFailed("event-2"))
    harness.emit(executionSucceeded("event-3"))

    expect(harness.notifications).toEqual([
      {
        title: "Demo session",
        message: "boom",
        notification: { when: "blurred" },
        sound: { name: "error", when: "always" },
      },
    ])
  })
})

describe("idle reminder", () => {
  const reminder: AttentionNotifyOptions = {
    title: "Orbit",
    message: "Orbit is waiting for your input",
    notification: { when: "blurred" },
    sound: { name: "default", when: "blurred" },
    bell: { when: "blurred" },
  }
  const waiting = (harness: Awaited<ReturnType<typeof setup>>) =>
    harness.notifications.filter((item) => item.message === reminder.message)

  test("fires once, after the configured seconds, for a root session", async () => {
    const harness = await setup(undefined, 0.05)
    harness.emit(executionStarted("s"))
    harness.emit(executionSucceeded("d"))
    expect(waiting(harness)).toEqual([])
    await Bun.sleep(150)
    expect(waiting(harness)).toEqual([reminder])
    await Bun.sleep(150)
    expect(waiting(harness)).toHaveLength(1)
  })

  test("stays off at 0 seconds and for subagent sessions", async () => {
    const off = await setup(undefined, 0)
    off.emit(executionSucceeded("d"))
    const sub = await setup(undefined, 0.05)
    sub.emit(executionSucceeded("d2", "subagent"))
    await Bun.sleep(150)
    expect(waiting(off)).toEqual([])
    expect(waiting(sub)).toEqual([])
  })

  test.each([
    ["a keypress", (h: Awaited<ReturnType<typeof setup>>) => h.keys.emit("keypress", {})],
    ["a new execution", (h: Awaited<ReturnType<typeof setup>>) => h.emit(executionStarted("again"))],
    [
      "a pending permission",
      (h: Awaited<ReturnType<typeof setup>>) =>
        h.emit({ id: "p", created: 0, type: "permission.asked", data: permission("permission-1") }),
    ],
    [
      "a pending form",
      (h: Awaited<ReturnType<typeof setup>>) =>
        h.emit({ id: "f", created: 0, type: "form.created", data: { form: form("form-1") } }),
    ],
  ])("is cancelled by %s", async (_name, act) => {
    const harness = await setup(undefined, 0.05)
    harness.emit(executionSucceeded("d"))
    act(harness)
    await Bun.sleep(150)
    expect(waiting(harness)).toEqual([])
  })

  test("does not start while a permission is already pending", async () => {
    const harness = await setup(undefined, 0.05)
    harness.emit({ id: "p", created: 0, type: "permission.asked", data: permission("permission-1") })
    harness.emit(executionSucceeded("d"))
    await Bun.sleep(150)
    expect(waiting(harness)).toEqual([])
  })
})

// The real plugin through the real attention host: a subagent that needs a person rings the bell, its completion does not.
describe("terminal bell for subagents", () => {
  test.each([
    ["root permission", () => permissionAsked("per-1", "session"), true],
    ["subagent permission", () => permissionAsked("per-2", "subagent"), true],
    ["subagent form", () => ({ id: "f", created: 0, type: "form.created", data: { form: form("form-2", "subagent") } }) as OrbitEvent, true],
    ["subagent Session done", () => executionSucceeded("d1", "subagent"), false],
  ] as const)("%s rings: %p", async (_name, event, rings) => {
    const written: string[] = []
    const attention = createTuiAttention({
      renderer: {
        isDestroyed: false,
        on: () => {},
        off: () => {},
        triggerNotification: () => true,
        idle: async () => {},
      },
      config: {
        attention: {
          notifications: false,
          sound: false,
          bell: true,
          idle_reminder: 0,
          volume: 0.4,
          sound_pack: "orbit.default",
          sounds: {},
        },
      },
      writeBell: (text) => written.push(text),
    })
    const harness = await setup(undefined, 0, attention)
    harness.emit(event())
    await Bun.sleep(20)
    expect(written).toEqual(rings ? ["\x07"] : [])
    attention.dispose()
  })
})

function permissionAsked(id: string, sessionID: string): OrbitEvent {
  return { id: "e-" + id, created: 0, type: "permission.asked", data: permission(id, sessionID) } as OrbitEvent
}
