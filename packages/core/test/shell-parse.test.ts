import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import os from "os"
import path from "path"
import { ShellParse } from "@orbit/core/shell/parse"

describe("ShellParse", () => {
  test("splits bash commands and derives reusable prefixes", async () => {
    const result = await Effect.runPromise(
      ShellParse.scan("git status && npm run test -- --watch", "/bin/bash", "/workspace"),
    )
    expect(result).toEqual({
      commands: [
        { resource: "git status", save: "git status *" },
        { resource: "npm run test -- --watch", save: "npm run test *" },
      ],
      directories: [],
    })
  })

  test("portable scanning preserves supported command resources and directories", async () => {
    const commands = [
      "git status && npm run test -- --watch",
      "echo $(curl evil | sed s/x/y/)",
      "cd /tmp/$USER && git status",
      "if true; then printf yes; else printf no; fi",
      "if true; then export X=$(printf value); unset X; fi",
      "if export X=$(printf value); then printf done; fi",
      "export X=value >$(printf output)",
      "echo $((1 + 1))",
      "cd ~; cd src&&cd ..; pwd",
    ]

    for (const command of commands) {
      const legacy = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace"))
      const portable = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true }))
      expect(portable, command).toEqual(legacy)
      expect(await Effect.runPromise(ShellParse.scanPortable(command, "/bin/bash", "/workspace"))).toEqual(portable)
    }
  })

  test("portable scanning handles heredocs with the existing permission resource", async () => {
    const command = "cat <<'EOF'\nstatic body\nEOF"
    const legacy = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace"))
    expect(legacy.commands).toEqual([{ resource: command, save: "cat *" }])
    expect(await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true }))).toEqual(
      legacy,
    )
  })

  test.each(['c"\\d" relative', "'cd' /tmp", "c''d /tmp", "c\\\nd /tmp"])(
    "portable scanning keeps source-shaped command heads under shell authorization: %s",
    async (command) => {
      const portable = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true }))
      expect(portable.commands.map((item) => item.resource)).toEqual([command])
      expect(portable.directories).toEqual([])
    },
  )

  test.each(["declare", "typeset", "export", "readonly", "local", "unset", "unsetenv"])(
    "preserves declaration permission behavior for %s without hiding nested commands",
    async (name) => {
      for (const command of [`${name} X`, `${name} "$(printf X)"; git status`]) {
        const legacy = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace"))
        expect(legacy.commands).toEqual(
          command.includes("$(")
            ? [
                { resource: "printf X", save: "printf *" },
                { resource: "git status", save: "git status *" },
              ]
            : [],
        )
        expect(
          await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })),
        ).toEqual(legacy)
      }

      for (const command of [`"${name}" X`, `FOO=bar ${name} X`, `command ${name} X`, `>${name}.txt ${name} X`]) {
        const legacy = await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace"))
        expect(legacy.commands).toHaveLength(1)
        expect(
          await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true })),
        ).toEqual(legacy)
      }
    },
  )

  test("declaration filtering retains directory checks inside command substitutions", async () => {
    const command = "export X=$(cd /outside; printf value)"
    const expected = { commands: [{ resource: "printf value", save: "printf *" }], directories: ["/outside"] }
    expect(await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace"))).toEqual(expected)
    expect(await Effect.runPromise(ShellParse.scan(command, "/bin/bash", "/workspace", { portable: true }))).toEqual(
      expected,
    )
  })

  test("does not treat PowerShell commands as Bash declarations", async () => {
    expect(await Effect.runPromise(ShellParse.scanPortable("export X; unset X", "pwsh", "/workspace"))).toEqual({
      commands: [
        { resource: "export X", save: "export *" },
        { resource: "unset X", save: "unset *" },
      ],
      directories: [],
    })
  })

  test("splits PowerShell commands case-insensitively", async () => {
    const result = await Effect.runPromise(
      ShellParse.scan(
        "Get-ChildItem; Write-Output 'done'",
        "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "C:\\workspace",
      ),
    )
    expect(result.commands).toEqual([
      { resource: "Get-ChildItem", save: "Get-ChildItem *" },
      { resource: "Write-Output 'done'", save: "Write-Output *" },
    ])
  })

  test("does not permission directory changes separately", async () => {
    const result = await Effect.runPromise(ShellParse.scan("cd 'src dir' && git status", "/bin/bash", "/workspace"))
    expect(result).toEqual({
      commands: [{ resource: "git status", save: "git status *" }],
      directories: ["src dir"],
    })
  })

  test("extracts PowerShell directory parameters", async () => {
    const result = await Effect.runPromise(
      ShellParse.scan("Set-Location -LiteralPath '..\\outside'; Get-ChildItem", "pwsh", "C:\\workspace"),
    )
    expect(result.directories).toEqual(["..\\outside"])
  })

  test("expands deterministic directory variables", async () => {
    const bash = await Effect.runPromise(ShellParse.scan("cd ~/src", "/bin/bash", "/workspace"))
    expect(bash.directories).toEqual([path.join(os.homedir(), "src")])

    const backslash = await Effect.runPromise(ShellParse.scan("cd '~\\src'", "/bin/bash", "/workspace"))
    expect(backslash.directories).toEqual(process.platform === "win32" ? [path.join(os.homedir(), "src")] : ["~\\src"])

    const powershell = await Effect.runPromise(
      ShellParse.scan('Set-Location "$PWD/src"; Set-Location $PSHOME', "/usr/local/bin/pwsh", "/workspace"),
    )
    expect(powershell.directories).toEqual(["/workspace/src", "/usr/local/bin"])
  })

  // The plain words a command takes, which a check of links that lead out of an untrusted project resolves. A word with an
  // expansion has no value before the command runs and is left out; that is the shell analysis of a later milestone.
  test.each([
    ["cat cfg/orbit.json", "/bin/bash", ["cfg/orbit.json"]],
    ["mv cfg/AGENTS.md cfg/AGENTS.md.bak", "/bin/bash", ["cfg/AGENTS.md", "cfg/AGENTS.md.bak"]],
    ['cat "cfg/orbit.json" \'cfg\'/x c"f"g/y', "/bin/bash", ["cfg/orbit.json", "cfg/x", "cfg/y"]],
    ["echo hi > cfg/AGENTS.md", "/bin/bash", ["hi", "cfg/AGENTS.md"]],
    ["git --git-dir=cfg/repo status -s", "/bin/bash", ["cfg/repo", "status"]],
    ["FOO=1 tar -C cfg -cf out.tar .", "/bin/bash", ["cfg", "out.tar", "."]],
    // A substitution's own command is a command with words of its own.
    ["cat $HOME/x `echo cfg`/y $(echo cfg)/z", "/bin/bash", ["cfg", "cfg"]],
    ["cd cfg && ls", "/bin/bash", ["cfg"]],
    ["Get-Content cfg/orbit.json", "pwsh", ["cfg/orbit.json"]],
    ["Move-Item -Path cfg/AGENTS.md -Destination 'cfg/x.bak'", "pwsh", ["cfg/AGENTS.md", "cfg/x.bak"]],
    ["echo hi > cfg/AGENTS.md", "pwsh", ["hi", "cfg/AGENTS.md"]],
    ["Get-Content $env:USERPROFILE/x", "pwsh", []],
  ] as const)("names the plain words of %s in %s", async (command, shell, expected) => {
    expect(await Effect.runPromise(ShellParse.operands(command, shell))).toEqual([...expected])
  })
})
