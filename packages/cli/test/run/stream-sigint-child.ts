// Drives the stream runner into the state of FU-M4-295 and then checks that the process still runs a timer. Started by
// stream-end-race.test.ts in a child process with a deadline, because a driver that spins in microtasks blocks every
// timer, including the test runner's own.
import { delivered, harness } from "../fixture/stream-harness"

// The server is going away with this process: it never answers the interrupt, and its wait fails.
const h = harness({
  stdout: false,
  interrupt: () => new Promise(() => {}),
  wait: () => Promise.reject(new Error("the server went away")),
})
h.send({ type: "user", text: "go" })
const deadline = Date.now() + 10_000
while (h.state.admitted.length === 0 && Date.now() < deadline) await Bun.sleep(10)
h.emit(delivered(h.state.admitted[0]))
await Bun.sleep(100)
// The first SIGINT: the input stops, the wait fails, and the first fatal() waits for the interrupt.
process.emit("SIGINT")
await Bun.sleep(200)
// The event stream breaks while that interrupt is still unanswered.
setTimeout(() => {
  process.stdout.write("responsive\n")
  // The second SIGINT exits with 130 at once.
  process.emit("SIGINT")
}, 300)
h.drop()
