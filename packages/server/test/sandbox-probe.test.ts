import { afterEach, describe, expect, test } from "bun:test"
import { ShellSandbox } from "@orbit/core/shell/sandbox"
import { ServerManaged } from "../src/managed"

const original = { ...ShellSandbox.host }
afterEach(() => Object.assign(ShellSandbox.host, original))

// The doctor asks the runner's own launch, so every platform input must give what `wrap` gives for the same input.
describe("the doctor's sandbox probe", () => {
  const rows = [
    { name: "wsl1", platform: "linux", release: "4.4.0-19041-Microsoft", env: {}, type: "unsupported" },
    { name: "wsl2", platform: "linux", release: "5.15.90.1-microsoft-standard-WSL2", env: {}, type: "any" },
    { name: "custom wsl2 kernel", platform: "linux", release: "6.6.0-custom", env: { WSL_DISTRO_NAME: "Ubuntu" }, type: "any" },
    { name: "linux", platform: "linux", release: "6.1.0-generic", env: {}, type: "any" },
    { name: "darwin", platform: "darwin", release: "23.0.0", env: {}, type: "any" },
    { name: "win32", platform: "win32", release: "10.0.26200", env: {}, type: "unwrapped" },
    { name: "freebsd", platform: "freebsd", release: "14.0", env: {}, type: "unwrapped" },
  ] as const
  for (const row of rows)
    test(row.name, () => {
      Object.assign(ShellSandbox.host, { platform: row.platform, release: row.release, env: row.env, interop: false })
      const probed = ServerManaged.sandboxProbe()
      const direct = ShellSandbox.wrap({
        platform: row.platform,
        release: row.release,
        env: row.env,
        interop: false,
        settings: { enabled: true },
        shell: "sh",
        args: [],
        cwd: process.cwd(),
        writable: [],
        tool: probed.type === "wrapped" ? probed.command : undefined,
      })
      expect(probed).toEqual(direct)
      if (row.type !== "any") expect(probed.type).toBe(row.type)
      // Plain Linux, macOS and WSL2 are never refused as unsupported.
      else expect(probed.type).not.toBe("unsupported")
    })

  test("wsl1 gives the reason that points to WSL2", () => {
    Object.assign(ShellSandbox.host, { platform: "linux", release: "4.4.0-19041-Microsoft", env: {} })
    const probed = ServerManaged.sandboxProbe()
    expect(probed.type === "unsupported" && probed.reason).toContain("WSL2")
  })
})
