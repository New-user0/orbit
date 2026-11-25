// Every `orb` child process the tests start runs src/index.ts from source, which costs about two seconds of CPU before it
// answers its first request. A file that starts many at once (permission-files runs up to --max-concurrency rows, and the
// parallel workers each do the same) leaves a small runner with more starting processes than cores, so each one takes
// several times longer and a fixed wait for the first answer runs out although nothing is wrong. The gate lets only a few
// processes start at a time in one worker: a caller takes a slot, waits for its child's first answer, and releases the
// slot, so its deadline measures the start and not the queue. It changes no assertion; it only orders the starts.
const limit = Math.max(1, Number(process.env.ORBIT_TEST_STARTS) || 3)
let running = 0
const queue: Array<() => void> = []

export async function startSlot<T>(run: () => Promise<T>) {
  const release = await takeSlot()
  try {
    return await run()
  } finally {
    release()
  }
}

/**
 * Waits for a slot and answers the function that gives it back, for a caller that starts its child inside the slot: the
 * child's start then competes only with the few others the gate admitted. Giving it back twice gives it back once.
 */
export async function takeSlot() {
  if (running >= limit) await new Promise<void>((resolve) => queue.push(resolve))
  else running++
  let held = true
  return () => {
    if (!held) return
    held = false
    // Hand the slot straight to the next waiter, so `running` stays at the limit while the queue is not empty.
    const next = queue.shift()
    if (next) next()
    else running--
  }
}
