import { expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import { createThemeSource } from "../src/context/theme"
import { tmpdir } from "./fixture/fixture"

// The terminal UI's theme source, which the theme provider asks for the custom themes: the user's own always, and the
// project's `.orbit/themes` only while the start folder is trusted (class 1), from the project's root down (D7). Each
// answer that changes what is read discovers the themes again; one that changes nothing does not.
async function layout() {
  const root = await tmpdir()
  const base = await realpath(root.path)
  const config = path.join(base, "config")
  const home = path.join(base, "home")
  const repo = path.join(base, "work", "repo")
  await mkdir(path.join(repo, ".git"), { recursive: true })
  await mkdir(home, { recursive: true })
  await Bun.write(path.join(config, "themes", "user-theme.json"), JSON.stringify({ base: "orbit" }))
  await Bun.write(
    path.join(base, "work", ".orbit", "themes", "clone-above-theme.json"),
    JSON.stringify({ base: "orbit" }),
  )
  await Bun.write(path.join(repo, ".orbit", "themes", "clone-own-theme.json"), JSON.stringify({ base: "orbit" }))
  return { config, home, repo, [Symbol.asyncDispose]: () => root[Symbol.asyncDispose]() }
}

async function inside<T>(directory: string, run: () => Promise<T>) {
  const before = process.cwd()
  process.chdir(directory)
  try {
    return await run()
  } finally {
    process.chdir(before)
  }
}

test("the project's themes are read only while the start folder is trusted, and each change of answer reads again", async () => {
  await using folders = await layout()
  await inside(folders.repo, async () => {
    const source = createThemeSource({ config: folders.config, home: folders.home })
    let discoveries = 0
    const unsubscribe = source.subscribeDiscover(() => discoveries++)
    const names = async () => Object.keys(await source.discover()).sort()

    // Before any answer, and while the answer is that it is not trusted, only the user's own themes are read.
    expect(await names()).toEqual(["user-theme"])
    source.trust({ trusted: false, root: folders.repo })
    expect(discoveries).toBe(0)
    expect(await names()).toEqual(["user-theme"])

    // Trusted: the project's own theme, and nothing from the folder above its root.
    source.trust({ trusted: true, root: folders.repo })
    expect(discoveries).toBe(1)
    expect(await names()).toEqual(["clone-own-theme", "user-theme"])
    source.trust({ trusted: true, root: folders.repo })
    expect(discoveries).toBe(1)

    // Revoked: the project's theme goes again.
    source.trust({ trusted: false, root: folders.repo })
    expect(discoveries).toBe(2)
    expect(await names()).toEqual(["user-theme"])

    unsubscribe()
    source.trust({ trusted: true, root: folders.repo })
    expect(discoveries).toBe(2)
  })
})

// m5-quality, FU-M4-380 (classes 3 and 14): the walk starts no higher than the folder the server decided trust for. Here
// the terminal UI's own walk would take the folder with `.git` above the start folder as the root, while the server
// decided for the start folder itself, as it does when it rejects that `.git` (a `.git` file that names no repository).
// The theme of the folder with `.git` is read only while the server's root is that folder (the control), and each change
// of the server's root reads the themes again.
test("the project's themes are read from the folder the server trusted down, and a change of that folder reads again", async () => {
  await using folders = await layout()
  const start = path.join(folders.repo, "sub")
  await Bun.write(path.join(start, ".orbit", "themes", "start-theme.json"), JSON.stringify({ base: "orbit" }))
  await inside(start, async () => {
    const source = createThemeSource({ config: folders.config, home: folders.home })
    let discoveries = 0
    const unsubscribe = source.subscribeDiscover(() => discoveries++)
    const names = async () => Object.keys(await source.discover()).sort()

    // The server decided for the start folder: the theme of the folder above it, which holds `.git`, is not read.
    source.trust({ trusted: true, root: start })
    expect(discoveries).toBe(1)
    expect(await names()).toEqual(["start-theme", "user-theme"])

    // The control: once the server's root is the folder with `.git`, its theme is read, and the change reads again.
    source.trust({ trusted: true, root: folders.repo })
    expect(discoveries).toBe(2)
    expect(await names()).toEqual(["clone-own-theme", "start-theme", "user-theme"])

    // And back.
    source.trust({ trusted: true, root: start })
    expect(discoveries).toBe(3)
    expect(await names()).toEqual(["start-theme", "user-theme"])
    unsubscribe()
  })
})
