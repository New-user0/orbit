import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { git } from "./git"
import { tmpdirScoped } from "./tmpdir"

// The keys of a git config, and the files beside it, that name a program for git to run (git help config, gitattributes,
// githooks). A clone chooses all of them, so a folder that nobody has decided about must not meet any. Each row plants one
// into a repository, with a program that writes a line into a marker file, and says which plain git command makes git run
// it. That command is the control of the row: it is run outside Orbit, in a repository of its own, and a marker proves the
// key is live, so a test that finds no marker after Orbit worked in a folder did not pass because the key was dead.

export interface Key {
  readonly name: string
  /** Writes what names the program into the repository at `root`, after its first commit and before the file is edited. */
  readonly plant: (root: string, program: string, folder: string) => Promise<void>
  /**
   * The plain git command, in the repository and outside Orbit, that makes git run the program. None for a key that git
   * starts only for a terminal, which a test of this kind cannot give it.
   */
  readonly trigger?: readonly string[]
  /** What the command reads on its input. */
  readonly input?: string
  /**
   * Whether the commands of the Git VCS provider reach the key when the folder is trusted: `true` where a command runs the
   * program (the demonstrated holes), `false` where the provider switches the key off itself, and nothing where the answer
   * depends on the git version and no test depends on it.
   */
  readonly provider?: boolean
}

const forward = (file: string) => file.replaceAll("\\", "/")

const hookNames = ["post-index-change", "reference-transaction", "post-checkout", "post-commit", "pre-auto-gc"]

// A hook is a script that starts the program; git needs the execute bit on it outside Windows.
const hooks = async (directory: string, program: string) => {
  await fs.mkdir(directory, { recursive: true })
  await Promise.all(
    hookNames.map(async (name) => {
      await Bun.write(path.join(directory, name), `#!/bin/sh\n"${forward(program)}"\n`)
      await fs.chmod(path.join(directory, name), 0o755)
    }),
  )
}

/** The output of a git command in `cwd`, for the setup of a fixture. */
const output = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const text = await new Response(child.stdout).text()
  await child.exited
  return text.trim()
}

export const keys: readonly Key[] = [
  {
    name: "core.fsmonitor",
    plant: (root, program) => git(root, "config", "core.fsmonitor", forward(program)),
    trigger: ["status"],
    provider: false,
  },
  {
    name: "core.hooksPath",
    plant: async (root, program, folder) => {
      await hooks(path.join(folder, "hooks"), program)
      await git(root, "config", "core.hooksPath", forward(path.join(folder, "hooks")))
    },
    trigger: ["commit", "--allow-empty", "-m", "trigger"],
  },
  {
    name: ".git/hooks",
    plant: (root, program) => hooks(path.join(root, ".git", "hooks"), program),
    trigger: ["commit", "--allow-empty", "-m", "trigger"],
  },
  {
    name: "filter.<driver>.clean",
    plant: async (root, program) => {
      await git(root, "config", "filter.marker.clean", `"${forward(program)}"`)
      await Bun.write(path.join(root, ".gitattributes"), "*.txt filter=marker\n")
    },
    trigger: ["add", "-A"],
    provider: true,
  },
  {
    name: "diff.<driver>.textconv",
    plant: async (root, program) => {
      await git(root, "config", "diff.marker.textconv", `"${forward(program)}"`)
      await Bun.write(path.join(root, ".gitattributes"), "*.txt diff=marker\n")
    },
    trigger: ["diff", "HEAD"],
    provider: true,
  },
  {
    name: "diff.external",
    plant: (root, program) => git(root, "config", "diff.external", `"${forward(program)}"`),
    trigger: ["diff", "HEAD"],
    provider: false,
  },
  {
    // A commit with a signature header is verified when a log shows signatures, and git runs the program to verify it.
    name: "gpg.program",
    plant: async (root, program, folder) => {
      await git(root, "config", "gpg.program", forward(program))
      await git(root, "config", "log.showSignature", "true")
      const tree = await output(root, "write-tree")
      const parent = await output(root, "rev-parse", "HEAD")
      const file = path.join(folder, "signed-commit.txt")
      await Bun.write(
        file,
        `tree ${tree}\nparent ${parent}\nauthor T <t@orbit.test> 0 +0000\ncommitter T <t@orbit.test> 0 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n AAAA\n -----END PGP SIGNATURE-----\n\nsigned\n`,
      )
      const signed = await output(root, "hash-object", "-t", "commit", "-w", "--literally", file)
      await git(root, "update-ref", "-m", "commit: signed", "HEAD", signed)
    },
    trigger: ["log", "-1"],
    provider: true,
  },
  {
    name: "core.sshCommand",
    plant: async (root, program) => {
      await git(root, "remote", "set-url", "origin", "ssh://git@example.test/orbit/clone.git")
      await git(root, "config", "core.sshCommand", `"${forward(program)}"`)
    },
    trigger: ["ls-remote", "origin"],
  },
  {
    // Git pages only for a terminal, and a test has none: the key is planted, and no plain command can run it here.
    name: "core.pager",
    plant: (root, program) => git(root, "config", "core.pager", `"${forward(program)}"`),
  },
  {
    name: "credential.helper",
    plant: (root, program) => git(root, "config", "credential.helper", `!"${forward(program)}"`),
    trigger: ["credential", "fill"],
    input: "protocol=https\nhost=example.test\n\n",
  },
  {
    // An included file is read by git, so a program that it names runs. The reader of Orbit follows no include.
    name: "include.path",
    plant: async (root, program, folder) => {
      const included = path.join(folder, "included.config")
      await Bun.write(included, `[core]\n\tfsmonitor = ${forward(program)}\n`)
      await git(root, "config", "include.path", forward(included))
    },
    trigger: ["status"],
  },
]

/**
 * A plain git command, as a person types it. The environment keeps the system and global config out, so that the config of
 * the repository is the only one that names a program, and git never waits at a prompt.
 */
export const plain = async (cwd: string, args: readonly string[], input?: string) => {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: {
      // A variable of git that the shell of a developer sets (`GIT_ASKPASS` of an editor, `GIT_SSH_COMMAND`, a pager) would
      // take the place of what the repository's config names, or open a window and wait for an answer.
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(GIT_|SSH_|VSCODE_GIT)/.test(name))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "",
      SSH_ASKPASS: "",
    },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "ignore",
    stderr: "ignore",
  })
  await child.exited
}

/** A program in `folder` that records each run in a marker file beside it, and the reader of its runs. */
export const marker = async (folder: string) => {
  const file = path.join(folder, "marker.txt")
  const program = path.join(folder, "program.sh")
  await Bun.write(program, `#!/bin/sh\necho ran >> "${forward(file)}"\n`)
  await fs.chmod(program, 0o755)
  return {
    program,
    ran: async () => ((await Bun.file(file).exists()) ? (await Bun.file(file).text()).split(/\r?\n/).filter(Boolean) : []),
  }
}

/**
 * A repository in a folder of its own with `key` planted, a remote, a first commit and a change that is not committed yet,
 * and the reader of what its marker program has run. Nothing runs the program while it is built.
 */
export const planted = (key: Key, options: { readonly remote?: string } = {}) =>
  Effect.gen(function* () {
    const folder = (yield* tmpdirScoped("orbit-git-key-")).path
    const root = path.join(folder, "clone")
    const recorder = yield* Effect.promise(() => marker(folder))
    yield* Effect.promise(() => build(root, [key], recorder.program, folder, options.remote))
    return { root, folder, ran: () => Effect.promise(recorder.ran) }
  })

/**
 * Makes a repository at `root` with each key of `planting` planted to run `program`, a remote, a first commit and a change
 * that is not committed yet. `folder` holds what a key keeps outside the repository. Nothing runs the program meanwhile.
 */
export const build = async (
  root: string,
  planting: readonly Key[],
  program: string,
  folder: string,
  remote = "https://example.test/orbit/clone.git",
) => {
  await fs.mkdir(root, { recursive: true })
  await git(root, "init", "-b", "main")
  await git(root, "config", "commit.gpgsign", "false")
  await git(root, "config", "user.email", "test@orbit.test")
  await git(root, "config", "user.name", "Test")
  await git(root, "config", "core.autocrlf", "false")
  await git(root, "remote", "add", "origin", remote)
  await Bun.write(path.join(root, "a.txt"), "one\n")
  await git(root, "add", "a.txt")
  await git(root, "commit", "-m", "one")
  for (const key of planting) await key.plant(root, program, folder)
  // Edited after the keys are planted, so that a command that compares the tree with the index has to run a filter or a
  // text conversion on it.
  await Bun.write(path.join(root, "a.txt"), "two\n")
}

/** What the plain command of a row ran in a repository of its own, which shows that the key is live there. */
export const live = (key: Key) =>
  Effect.gen(function* () {
    const found = yield* planted(key)
    if (key.trigger) yield* Effect.promise(() => plain(found.root, key.trigger!, key.input))
    return yield* found.ran()
  })
