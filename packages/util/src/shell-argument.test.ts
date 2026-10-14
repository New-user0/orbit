import { describe, expect, test } from "bun:test"
import { shellArgument } from "./shell-argument.js"

describe("shellArgument", () => {
  const hostile = ["$(touch PWNED)", "`touch PWNED`", "it's", 'a"b', "a b", "a;b", "a&b", "a|b", "a\\b", "~/x", "${HOME}"]

  test("leaves a plain name as it is", () => {
    expect(shellArgument("/work/project", "linux")).toBe("/work/project")
    expect(shellArgument("C:\\work\\project", "win32")).toBe("C:\\work\\project")
  })

  test("quotes anything a POSIX shell would act on, so that it reads back as one literal", async () => {
    const sh = Bun.which("sh")
    for (const name of hostile) {
      const quoted = shellArgument(name, "linux")
      expect(quoted).toBeDefined()
      if (sh === null || process.platform === "win32") continue
      const ran = Bun.spawnSync([sh, "-c", `printf %s ${quoted}`])
      expect(ran.stdout.toString()).toBe(name)
    }
  })

  test("gives no argument for a name with a control character, a line break or a bidirectional mark", () => {
    for (const name of ["a\u001bb", "a\nb", "a\u0000b", "a\u202eb", "a\u0085b", String.fromCharCode(0x2028), ""])
      for (const platform of ["linux", "win32"] as const) expect(shellArgument(name, platform)).toBeUndefined()
  })

  test("on Windows prints only names that neither PowerShell nor cmd expands", () => {
    expect(shellArgument("C:\\Program Files (x86)\\app", "win32")).toBe('"C:\\Program Files (x86)\\app"')
    for (const name of ["$(x)", "`x`", 'a"b', "it's", "a%b%", "a&b", "a^b", "a;b", "$HOME"])
      expect(shellArgument(name, "win32")).toBeUndefined()
  })
})
