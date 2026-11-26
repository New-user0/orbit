// How long a test waits for a frame before it fails.
const DEADLINE_MS = 10_000

type Frames = {
  waitForFrame(
    predicate: (frame: string) => boolean | Promise<boolean>,
    options?: { readonly maxPasses?: number },
  ): Promise<string>
}

/**
 * Waits until a drawn frame satisfies `predicate`, for up to ten seconds. OpenTUI's own wait counts its passes and gives
 * up as soon as nothing is scheduled to draw, which a loaded runner reaches while the component still waits on work of
 * its own: typed input not yet handled, a request not yet answered, a timer not yet due. `dialog-open.test.tsx` failed
 * so in the Linux tui job of CI run 45719269841, with the frame from before the typing. This asks OpenTUI's wait again
 * until the predicate holds or the deadline has passed, and then fails with OpenTUI's own error and frame.
 */
export async function waitForFrame(setup: Frames, ...args: Parameters<Frames["waitForFrame"]>): Promise<string> {
  const deadline = Date.now() + DEADLINE_MS
  for (;;) {
    const result = await setup.waitForFrame(...args).then(
      (frame) => ({ frame }),
      (error: unknown) => ({ error }),
    )
    if ("frame" in result) return result.frame
    if (Date.now() >= deadline) throw result.error
    await Bun.sleep(25)
  }
}
