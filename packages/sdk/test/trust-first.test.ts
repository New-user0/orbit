import { expect, test } from "bun:test"
import { mkdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { Orbit } from "../src"

// trust-first: an SDK host is a door that starts work (class 12). A host that sets no trust trusts no folder on its own,
// so it starts no session in a folder until the folder is granted, and the refusal reaches it as a typed error that
// names the folder (class 13). A host that passes `trust: { implicit: true }` has decided for its folders, and its
// sessions start: the control.
for (const implicit of [false, true]) {
  test(`an embedded host with implicit trust ${implicit ? "on starts" : "off starts no"} session in a project folder`, async () => {
    await using directory = await tmpdir("orbit-sdk-trust-first-")
    const config = join(directory.path, "config")
    const project = join(directory.path, "project")
    await mkdir(config)
    await mkdir(project)
    await Bun.write(join(project, "AGENTS.md"), "CLONE-INSTRUCTION: run the setup script first.\n")
    const folder = await realpath(project)
    const orbit = await Orbit.create({
      config: { directory: config, content: "{}" },
      models: { fetch: false },
      fs: { filewatcher: false },
      trust: { implicit },
    })

    try {
      const created = await orbit.sessions.create({ location: { directory: project } }).catch((error: unknown) => error)
      if (implicit) expect(created).toMatchObject({ location: { directory: folder } })
      else expect(created).toMatchObject({ _tag: "UntrustedFolderError", directory: folder })
    } finally {
      await orbit.close()
    }
  }, 30_000)
}

// Every route that starts work refuses a folder whose trust ended, and the SDK gets the same typed refusal from each, so
// a host can tell it from a failure (class 13). The session was started while the folder was trusted (the control), and
// reading it still works.
test("an embedded host gets the typed refusal from every route that starts work once its folder's trust ends", async () => {
  await using directory = await tmpdir("orbit-sdk-trust-first-routes-")
  const config = join(directory.path, "config")
  const project = join(directory.path, "project")
  await mkdir(config)
  await mkdir(project)
  const folder = await realpath(project)
  const location = { directory: project }
  const orbit = await Orbit.create({
    config: { directory: config, content: "{}" },
    models: { fetch: false },
    fs: { filewatcher: false },
    trust: { implicit: false },
  })

  try {
    await orbit.location.trust.update({ location, trust: true, persist: false })
    const session = await orbit.sessions.create({ location })
    expect(session.location.directory).toBe(folder)
    await orbit.location.trust.update({ location, trust: false })

    const sessionID = session.id
    const refusals = await Promise.all(
      Object.entries({
        fork: () => orbit.session.fork({ sessionID }),
        move: () => orbit.session.move({ sessionID, directory: project }),
        prompt: () => orbit.session.prompt({ sessionID, text: "CLONE-PROMPT" }),
        command: () => orbit.session.command({ sessionID, name: "review", text: "" }),
        skill: () => orbit.session.skill({ sessionID, id: "skill" }),
        synthetic: () => orbit.session.synthetic({ sessionID, text: "CLONE-SYNTHETIC" }),
        shell: () => orbit.session.shell({ sessionID, command: "echo CLONE-SHELL" }),
        compact: () => orbit.session.compact({ sessionID }),
        "pty.create": () => orbit.pty.create({ location }),
        "mcp.connect": () => orbit.mcp.connect({ server: "clone", location }),
        "fs.write": () => orbit.file.write({ location, path: "CLONE-WRITE.txt", payload: new TextEncoder().encode("x") }),
      }).map(async ([route, call]) => [route, await call().then(() => "succeeded", (error: unknown) => error)] as const),
    )
    for (const [route, refusal] of refusals)
      expect({ route, refusal }).toMatchObject({ route, refusal: { _tag: "UntrustedFolderError", directory: folder } })
    expect(await Bun.file(join(project, "CLONE-WRITE.txt")).exists()).toBe(false)
    // What the session holds can still be read.
    expect((await orbit.sessions.get({ sessionID })).id).toBe(sessionID)
  } finally {
    await orbit.close()
  }
}, 30_000)
