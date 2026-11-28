import { expect, test } from "bun:test"
import { untrustedFolder } from "../src/handlers/trust-error"

// The refusal names the folder a clone chose the name of, so the message carries it without what would act on a
// terminal (class 9), and says how to trust it: for good with `orb trust`, or, for a home directory or a filesystem root,
// which Orbit never trusts for good, until Orbit restarts. The folder itself stays as it is in `directory`, which a client
// decodes as data. `trust-first.test.ts` reaches the same refusal over HTTP, on Linux with a folder named this way.
test("the refusal of an untrusted folder names it without its control characters and says how to trust it", () => {
  const directory = "/work/inner\u001b]0;owned\u0007\u001b[2J"

  const kept = untrustedFolder({ directory, persistent: true })
  expect(kept).toMatchObject({ _tag: "UntrustedFolderError", directory, persistent: true })
  expect(kept.message).toContain("/work/inner")
  expect(kept.message).toContain("is not trusted")
  expect(kept.message).toContain("`orb trust`")
  expect(kept.message).not.toMatch(/[\u0000-\u001f\u007f]/)

  const home = untrustedFolder({ directory: "/home/kit", persistent: false })
  expect(home).toMatchObject({ directory: "/home/kit", persistent: false })
  expect(home.message).toContain("/home/kit is not trusted")
  expect(home.message).toContain("never trusts for good")
  expect(home.message).toContain("until Orbit restarts")
  expect(home.message).not.toContain("`orb trust`")
})
