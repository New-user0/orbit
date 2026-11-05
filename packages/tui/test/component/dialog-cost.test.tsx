import { expect, test } from "bun:test"
import type { ModelInfo } from "@orbit/client"
import type { SessionCost } from "@orbit/schema/session-cost"
import { DialogCost } from "../../src/component/dialog-cost"
import { json } from "../fixture/tui-client"
import { model, renderLocal, session as sessionFixture } from "../fixture/local"

// clients-ux-23 part 2: `/cost` draws the server's summary of the whole session and its subagents, not the page of
// messages the client has loaded (FU-M2-026). The real dialog, the real client and a fetch handler that answers the
// route; what is asserted is the drawn frame. The catalog step stays in the client: it decides which rows are unpriced.

type Info = SessionCost.Info
type Row = Info["rows"][number]

const ID = "ses_cost"
const route = `/api/session/${ID}/cost`

// The branded money type is the schema's; a fixture states plain numbers.
const row = (modelID: string, overrides: Record<string, unknown> = {}) =>
  ({
    providerID: "provider",
    modelID,
    responses: 1,
    tokens: { input: 1_000, output: 500, reasoning: 0, cache: { read: 200, write: 100 } },
    cost: 0,
    unrecorded: 0,
    zero: 0,
    ...overrides,
  }) as unknown as Row
const info = (overrides: Record<string, unknown> = {}) =>
  ({ cost: 0, own: 0, subagents: 0, rows: [], ...overrides }) as unknown as Info

const priced = (id: string): ModelInfo => ({
  ...model(id),
  cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] as unknown as ModelInfo["cost"],
})

/** Opens `/cost` with the route answered by `answer`, and returns what was asked and the frame once `done` holds. */
async function open(input: {
  readonly answer: (url: URL) => Response | Promise<Response>
  readonly models?: ModelInfo[]
  readonly timeout?: number
  readonly loaded?: boolean
  readonly done?: (frame: string) => boolean
  readonly log?: (message: string, tags: Record<string, unknown>) => void
}) {
  const asked: string[] = []
  const setup = await renderLocal({
    log: (_level, message, tags) => input.log?.(message, { ...tags }),
    width: 100,
    height: 40,
    models: input.models,
    sessions: [sessionFixture(ID)],
    fetch: async (url) => {
      if (url.pathname.endsWith("/cost")) {
        asked.push(url.pathname)
        return input.answer(url)
      }
      if (url.pathname === `/api/session/${ID}/message`) {
        // The one page the client holds: a single response, with more older ones behind it.
        return json({
          data: [
            {
              id: "msg_loaded",
              type: "assistant",
              model: { providerID: "provider", id: "loaded-only" },
              tokens: { input: 7, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
              cost: 99,
              time: { created: 0, streamed: 1_000 },
            },
          ],
          cursor: { next: "older" },
        })
      }
    },
  })
  // The session route has loaded the session before the command is offered.
  if (input.loaded !== false) await setup.data.session.sync(ID)
  setup.dialog.replace(() => <DialogCost sessionID={ID} timeout={input.timeout} />)
  const done = input.done ?? ((frame: string) => frame.includes("Total cost"))
  for (let attempt = 0; attempt < 200 && !done(setup.captureCharFrame()); attempt++) {
    await Bun.sleep(25)
    await setup.renderOnce()
  }
  await Bun.sleep(50)
  await setup.renderOnce()
  return { setup, asked, frame: setup.captureCharFrame() }
}

const flat = (frame: string) => frame.replace(/\s+/g, " ")

// PT1, FU-M2-026: the rows are the server's, whatever the client has loaded.
test("the dialog shows the whole session's rows, not the loaded page", async () => {
  const answer = info({
    cost: 4.5,
    own: 4.5,
    rows: [
      row("long-run", {
        responses: 300,
        cost: 4.5,
        tokens: { input: 123_456, output: 65_432, reasoning: 0, cache: { read: 2_000_000, write: 0 } },
      }),
    ],
  })
  const { setup, asked, frame } = await open({ answer: () => json({ data: answer }), models: [priced("long-run")] })
  await using _ = setup
  expect(asked).toEqual([route])
  expect(flat(frame)).toContain("long-run")
  expect(flat(frame)).toContain("123.5K input")
  expect(flat(frame)).toContain("65.4K output")
  expect(flat(frame)).toContain("2.0M cache read")
  expect(flat(frame)).toContain("$4.50")
  // Nothing of the loaded page, and no claim that the breakdown covers only part of the session.
  expect(frame).not.toContain("loaded-only")
  expect(frame).not.toContain("$99")
  expect(flat(frame)).not.toContain("newest loaded")
  // No subagent spend, no Subagents line.
  expect(frame).not.toContain("Subagents")
})

// PT2: the reference prints cents above $0.50 and four decimals below; a price that is not known reads unknown, never
// $0 (FU-M2-027); the subagent split stays; names from the catalog and the records are escaped (class 9).
test("money follows the reference's decimals, unknown prices read unknown, and names are escaped", async () => {
  const money: ReadonlyArray<readonly [number, string]> = [
    [0.4321, "$0.4321"],
    [0.5, "$0.5000"],
    [0.75, "$0.75"],
    [12.3456, "$12.35"],
  ]
  for (const [cost, shown] of money) {
    const { setup, frame } = await open({
      answer: () => json({ data: info({ cost, own: cost, rows: [row("big", { cost })] }) }),
      models: [priced("big")],
    })
    await using _ = setup
    expect(flat(frame)).toMatch(new RegExp(`Total cost ${shown.replace("$", "\\$")}(?!\\d)`))
  }

  // Failed response with no recorded cost (FU-M2-027, claim 1): the spend is unknown, not $0.
  const unknown = await open({
    answer: () => json({ data: info({ rows: [row("local", { unrecorded: 1 })] }) }),
    models: [model("local")],
  })
  await using _unknown = unknown.setup
  expect(flat(unknown.frame)).toMatch(/Total cost unknown/)
  expect(unknown.frame).not.toContain("$0")

  // A model the catalog lists without a price: the server's recorded $0 is not a free model.
  const free = await open({
    answer: () => json({ data: info({ rows: [row("local", { zero: 1 })] }) }),
    models: [model("local")],
  })
  await using _free = free.setup
  expect(flat(free.frame)).toMatch(/Total cost unknown/)
  // A model the catalog does not list at all keeps the recorded $0.
  const unlisted = await open({ answer: () => json({ data: info({ rows: [row("elsewhere", { zero: 1 })] }) }), models: [] })
  await using _unlisted = unlisted.setup
  expect(flat(unlisted.frame)).toMatch(/Total cost \$0\.0000/)

  // Some priced, some not: the figure is shown and flagged as incomplete.
  const mixed = await open({
    answer: () =>
      json({
        data: info({ cost: 0.5, own: 0.5, rows: [row("big", { cost: 0.5 }), row("other", { unrecorded: 1 })] }),
      }),
    models: [priced("big")],
  })
  await using _mixed = mixed.setup
  expect(flat(mixed.frame)).toContain("+ unpriced")

  // Subagent spend is split out (FU-M2-027, claim 2).
  const family = await open({
    answer: () => json({ data: info({ cost: 1.3, own: 0.5, subagents: 0.8, rows: [row("big", { cost: 1.3 })] }) }),
    models: [priced("big")],
  })
  await using _family = family.setup
  expect(flat(family.frame)).toMatch(/Total cost \$1\.30/)
  expect(flat(family.frame)).toMatch(/Subagents \$0\.80/)

  // Spend no row explains shows as Other.
  const other = await open({
    answer: () => json({ data: info({ cost: 1, own: 1, other: 0.4, rows: [row("big", { cost: 0.6 })] }) }),
    models: [priced("big")],
  })
  await using _other = other.setup
  expect(flat(other.frame)).toMatch(/Other \$0\.4000/)

  // No row at all: the usage line and Other still show.
  const bare = await open({ answer: () => json({ data: info({ cost: 0.3, own: 0.3, other: 0.3, rows: [] }) }) })
  await using _bare = bare.setup
  expect(flat(bare.frame)).toMatch(/Usage: 0 input, 0 output/)
  expect(flat(bare.frame)).toMatch(/Other \$0\.3000 \u00b7 undone responses, older usage/)

  // Hostile names: a model ID in a record, and a name in the catalog.
  const hostile = "evil\u001b]0;pwned\u0007\u009b2K‮name"
  const named = await open({
    answer: () => json({ data: info({ rows: [row(hostile, { cost: 0.1 }), row("listed", { cost: 0.1 })] }) }),
    models: [{ ...priced("listed"), name: hostile }],
  })
  await using _named = named.setup
  expect(named.frame).toContain("evil")
  expect(named.frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})

// PT3: the code changes line shows only when the server counted them; a session from before the counter has none.
test("code changes show only when counted", async () => {
  const counted = await open({ answer: () => json({ data: info({ lines: { added: 12, removed: 1 } }) }) })
  await using _counted = counted.setup
  expect(flat(counted.frame)).toMatch(/Code changes 12 lines added, 1 line removed/)

  const zero = await open({ answer: () => json({ data: info({ lines: { added: 0, removed: 0 } }) }) })
  await using _zero = zero.setup
  expect(flat(zero.frame)).toMatch(/Code changes 0 lines added, 0 lines removed/)

  const older = await open({ answer: () => json({ data: info() }) })
  await using _older = older.setup
  expect(older.frame).not.toContain("Code changes")
})

// PT4, classes 7 and 13: each failure is one line, and none crashes the dialog.
// Two providers of one model keep two rows, so the provider is drawn beside the name; a session with no response yet
// draws a line of zeros, as the reference does.
test("each row names its provider, and an empty session draws a line of zeros", async () => {
  const two = await open({
    answer: () =>
      json({
        data: info({
          cost: 1,
          own: 1,
          rows: [
            row("shared", { providerID: "first", cost: 0.6 }),
            row("shared", { providerID: "second\u001b[31m", cost: 0.4 }),
          ],
        }),
      }),
    models: [priced("shared")],
  })
  await using _two = two.setup
  expect(flat(two.frame)).toContain("· first")
  expect(flat(two.frame)).toContain("· second")
  expect(two.frame).not.toContain("\u001b")

  const empty = await open({ answer: () => json({ data: info() }) })
  await using _empty = empty.setup
  expect(flat(empty.frame)).toContain("Usage: 0 input, 0 output, 0 cache read, 0 cache write")
  expect(empty.frame).not.toContain("No model response")
})

test("an old server and an unknown session each draw one line", async () => {
  const cases: ReadonlyArray<{
    readonly name: string
    readonly answer: () => Response | Promise<Response>
    readonly timeout?: number
    readonly line: string
  }> = [
    { name: "old server", answer: () => new Response(null, { status: 404 }), line: "older than this client" },
    {
      name: "unknown session",
      answer: () => json({ _tag: "SessionNotFoundError", sessionID: ID, message: `Session not found: ${ID}` }, { status: 404 }),
      line: "Session not found",
    },
    { name: "bad body", answer: () => json({ data: { cost: "lots" } }), line: "could not be read" },
    { name: "no answer", answer: () => new Promise<Response>(() => {}), timeout: 50, line: "did not answer in time" },
  ]
  for (const item of cases) {
    const { setup, frame } = await open({
      answer: item.answer,
      timeout: item.timeout,
      done: (text) => flat(text).includes(item.line),
    })
    await using _ = setup
    expect(flat(frame), item.name).toContain(item.line)
    expect(frame, item.name).not.toContain("Total cost")
    // A failure replaces the waiting line.
    expect(frame, item.name).not.toContain("Reading the cost")
  }
})

// A reasoning count is drawn only for a model that used reasoning.
test("reasoning tokens are named only when a model used them", async () => {
  const used = await open({
    answer: () =>
      json({
        data: info({
          cost: 1,
          own: 1,
          rows: [row("thinker", { cost: 0.5, tokens: { input: 1, output: 1, reasoning: 2_000, cache: { read: 0, write: 0 } } }), row("plain", { cost: 0.5 })],
        }),
      }),
    models: [priced("thinker"), priced("plain")],
  })
  await using _used = used.setup
  expect(flat(used.frame)).toContain("2.0K reasoning")
  expect(flat(used.frame).match(/reasoning/g)).toHaveLength(1)
})

// Class 7: an entry of the rows the client cannot read costs only itself.
test("a row that does not decode costs only itself", async () => {
  const logged: Array<{ message: string; tags: Record<string, unknown> }> = []
  const { setup, frame } = await open({
    log: (message, tags) => logged.push({ message, tags }),
    answer: () =>
      json({ data: { ...info({ cost: 0.6, own: 0.6 }), rows: [row("good", { cost: 0.6 }), { providerID: 1 }, null] } }),
    models: [priced("good")],
  })
  await using _ = setup
  expect(flat(frame)).toContain("good")
  expect(flat(frame)).toMatch(/Total cost \$0\.60/)
  // The two rows left out are named once in the log.
  expect(logged.filter((line) => line.message.startsWith("Left out cost rows"))).toEqual([
    expect.objectContaining({ tags: expect.objectContaining({ dropped: ["rows[1]", "rows[2]"] }) }),
  ])
})

// Class 9: a refusal's text comes from the server, and a transport error's from the network; neither may carry a control
// sequence to the screen. A typed refusal shows the server's message alone; any other failure is named as unreadable.
test("a failure's text is escaped before it is drawn", async () => {
  const typed = await open({
    answer: () =>
      json({ _tag: "SessionNotFoundError", sessionID: ID, message: "Session not found\u001b]0;pwned\u0007\u009b2K" }, { status: 404 }),
    done: (text) => flat(text).includes("Session not found"),
  })
  await using _typed = typed.setup
  expect(flat(typed.frame)).toContain("Session not found")
  expect(flat(typed.frame)).not.toContain("Could not read session cost")
  expect(typed.frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)

  const other = await open({
    answer: () => Promise.reject(new Error("socket\u001b]0;pwned\u0007 closed\u009b2K")),
    done: (text) => flat(text).includes("Could not read session cost"),
  })
  await using _other = other.setup
  expect(flat(other.frame)).toMatch(/Could not read session cost: .*socket.*closed/)
  expect(other.frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})

// Mutation: price with the catalog of a session that is not loaded. Without the session there is no catalog, and the
// dialog still draws what the server said.
test("a session that is not loaded draws the cost without a catalog", async () => {
  const { setup, frame } = await open({
    answer: () => json({ data: info({ cost: 1.5, own: 1.5, rows: [row("m", { cost: 1.5 })] }) }),
    models: [priced("m")],
    loaded: false,
  })
  await using _ = setup
  expect(flat(frame)).toContain("Total cost")
  expect(flat(frame)).toContain("$1.50")
})
