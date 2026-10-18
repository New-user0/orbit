import { expect, test } from "bun:test"
import { createAppFixture, promptReady } from "./fixture/app"

// A cli.json that /vim writes to, as the host would: the draft is changed in place and the result comes back.
function host(initial: { prompt?: { vim?: boolean } }) {
  const state = { prompt: { ...initial.prompt } as { vim?: boolean } }
  return {
    state,
    update: async (update: (draft: any) => void) => {
      update(state)
      return structuredClone(state)
    },
  }
}

test.each([
  { before: undefined, after: true, said: "Vim keys are on" },
  { before: true, after: false, said: "Vim keys are off" },
  { before: false, after: true, said: "Vim keys are on" },
])("/vim flips prompt.vim from $before to $after and says so", async ({ before, after, said }) => {
  const cli = host({ prompt: before === undefined ? {} : { vim: before } })
  await using setup = await createAppFixture({ config: { animations: false }, update: cli.update })
  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  await setup.mockInput.typeText("/vim")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(said))
  expect(cli.state.prompt.vim).toBe(after)
})

test("/vim says why when cli.json cannot be written", async () => {
  await using setup = await createAppFixture({
    config: { animations: false },
    update: async () => {
      throw new Error("cli.json is read-only")
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => promptReady(frame))
  await setup.mockInput.typeText("/vim")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("cli.json is read-only"))
})
