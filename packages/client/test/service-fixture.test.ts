import { expect, test } from "bun:test"
import { serviceFixture } from "./fixture/service-fixture"
import { waitForExit } from "./fixture/service-timing"

// Service.ensure starts a second contender when the first has not registered within the spawn delay, which the tests'
// sped-up timing makes 200 ms: a cold `bun` start on a loaded runner takes longer. The real service lets one contender
// own the registration and the other exits. The fixture's `environment` mode did not: both registered, the later one
// overwrote the registration after `ensure` had returned the first, and the test read a port one above the endpoint
// (52430 against 52431 in the Windows client job of run 40120528525; 51166 against 51167 in run 40040440654), and the
// loser was left running (FU-M4-186). Like the real service, two contenders of one mode leave one registered owner.
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

for (const mode of ["environment", "coordinated"]) {
  test(`two ${mode} contenders leave one live owner, and it is the one registered`, async () => {
    await using fixture = await serviceFixture()
    const [first, second] = [fixture.spawn(mode), fixture.spawn(mode)]
    await fixture.waitForFile()
    // Give the loser the time it needs to give up, and the winner to finish writing.
    const settled = await Promise.race([
      Promise.all([first.exited, second.exited]).then(() => "both exited"),
      Bun.sleep(2_000).then(() => "running"),
    ])
    const info = await Bun.file(fixture.registration).json()
    const running = [first, second].filter((child) => alive(child.pid))

    expect(settled).toBe("running")
    expect(running.map((child) => child.pid)).toEqual([info.pid])
    for (const child of [first, second]) if (child.pid !== info.pid) await waitForExit(child.pid)
  }, 30_000)
}
