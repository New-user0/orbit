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
