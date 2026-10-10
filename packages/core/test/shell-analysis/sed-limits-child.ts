// Parses long and adversarial sed scripts and prints each result. Started by sed-parse.test.ts in a child process with a
// deadline, because a tokenizer that loops blocks the event loop and the test runner's own timeout never fires.
import { SedScript } from "../../src/shell/sed"

const scripts = [
  "s/" + "\\".repeat(5000) + "/b/",
  "1p;".repeat(3000) + "p",
  "s/" + "a".repeat(100_000) + "/b/",
  "/" + "\\/".repeat(50_000),
  "y/" + "\\".repeat(5001) + "/b/",
  "1,".repeat(20_000),
  " ".repeat(100_000) + "p",
]
console.log(JSON.stringify(scripts.map((script) => SedScript.parse(script).ok)))
