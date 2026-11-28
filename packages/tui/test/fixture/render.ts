import { createTestRenderer } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"

type Waits = {
  waitFor: (predicate: () => boolean | Promise<boolean>, options?: { maxPasses?: number }) => Promise<void>
  waitForFrame: (
    predicate: (frame: string) => boolean | Promise<boolean>,
    options?: { maxPasses?: number },
  ) => Promise<string>
}

type TimedWaits = {
  /** `timeout` is how long to keep looking, in ms. */
  waitFor: (predicate: () => boolean | Promise<boolean>, options?: { maxPasses?: number; timeout?: number }) => Promise<void>
  waitForFrame: (
    predicate: (frame: string) => boolean | Promise<boolean>,
    options?: { maxPasses?: number; timeout?: number },
  ) => Promise<string>
}

/**
 * How long one wait keeps looking, unless the call names its own: the test's own limit (the package's --timeout of
 * 30 s), so a wait never gives up while its row still has time. A 10 s default ran out first on loaded runners in rows
 * that had time left ('server plugin failures are visible at width ...' at 10.5 s, run 45854983953).
 */
const defaultTimeout = 30_000

/**
 * OpenTUI's `waitFor` and `waitForFrame` count frames and give up as soon as the renderer has nothing scheduled to draw.
 * That is not the end of the wait: an app that waits on a request, a timer or a stream draws nothing until the answer
 * arrives, so a loaded runner reached "idle" while the screen was still about to change and the wait failed on a
 * frame that was simply early (`dialog-open.test.tsx` in this PR's CI). These keep asking until the predicate holds or
 * the time limit ends, and then fail with the error of the last look, as OpenTUI's do. They never end because the
 * renderer is idle.
 */
export function timeBound<T extends Waits>(setup: T): Omit<T, keyof Waits> & TimedWaits {
  return {
    ...setup,
    waitFor: (predicate, options) => untilDeadline(options?.timeout, () => setup.waitFor(predicate, options)),
    waitForFrame: (predicate, options) => untilDeadline(options?.timeout, () => setup.waitForFrame(predicate, options)),
  }
}

async function untilDeadline<A>(timeout: number | undefined, look: () => Promise<A>) {
  const deadline = Date.now() + (timeout ?? defaultTimeout)
  for (;;) {
    const result = await look().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    if ("value" in result) return result.value
    if (Date.now() >= deadline) throw result.error
    await Bun.sleep(10)
  }
}

/** `testRender` of `@opentui/solid`, with waits that end by time and not by the renderer going idle. */
export async function testRenderTimed(...args: Parameters<typeof testRender>) {
  return timeBound(await testRender(...args))
}

/** `createTestRenderer` of `@opentui/core/testing`, with waits that end by time and not by the renderer going idle. */
export async function createTestRendererTimed(...args: Parameters<typeof createTestRenderer>) {
  return timeBound(await createTestRenderer(...args))
}
