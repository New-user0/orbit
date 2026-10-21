export * as GitSubmodules from "./git-submodules.js"

// A gitlink is the index entry of a submodule: a folder of the work tree with a `.git` of its own. To tell whether such a
// folder changed, `git status`, `git diff` against the work tree, `git checkout` of a branch, `git add` and the
// `git stash create` that `git merge` runs first start another git inside it. That git goes wherever the folder's `.git`
// points and takes the config and the attributes of the repository it finds there, so a file system monitor or a clean
// filter that repository names runs. Orbit asks whether git may run about the repository of the folder it works in
// (`GitAccess`), not about what a gitlink in it points at, so a gitlink whose `.git` names a repository that nobody
// trusted would run that repository's programs (class 1, class 3). Every git that Orbit starts therefore leaves
// submodules alone.

// The commands that compare the work tree with the index or a commit, which take `--ignore-submodules`.
const COMPARING = new Set(["status", "diff", "diff-files", "diff-index"])

// The options before the command that take their value as the next argument.
const VALUED = new Set(["-c", "-C", "--git-dir", "--work-tree", "--namespace"])

/**
 * The git command line `args` (without the program) made to leave every submodule alone: `diff.ignoreSubmodules=all`
 * ahead of the command, which the porcelain commands read (`git checkout <branch>` included), and
 * `--ignore-submodules=all` right after a command that compares the work tree, which the plumbing commands obey as well
 * and which a `submodule.<name>.ignore` in `.gitmodules` cannot overrule. `git add` has neither: a caller of `git add`
 * names the paths it adds, or leaves each gitlink out by name. A caller of `git merge` adds `pinned`.
 */
export function skip(args: readonly string[]): string[] {
  const at = command(args)
  return [
    "-c",
    "diff.ignoreSubmodules=all",
    ...args.slice(0, at + 1),
    ...(COMPARING.has(args[at] ?? "") ? ["--ignore-submodules=all"] : []),
    ...args.slice(at + 1),
  ]
}

/** The environment variable that holds `all` for the options of `pinned`. Give it to every git that gets them. */
export const VARIABLE = "ORBIT_GIT_SUBMODULE_IGNORE"

/**
 * Options that set `ignore = all` for each submodule of `names`, the names `.gitmodules` gives them. A submodule's own
 * `ignore`, in `.gitmodules` or in the repository's config, overrules `diff.ignoreSubmodules`, and a git that git starts
 * by itself takes no switch: `git merge` compares the work tree with a `git stash create` of its own. A setting for the
 * submodule on the command line outranks both. `--config-env` reads the value from VARIABLE and ends the key at the
 * last `=`, so a name that holds `=`, which `-c` would cut, stays whole.
 */
export function pinned(names: readonly string[]) {
  return names.map((name) => `--config-env=submodule.${name}.ignore=${VARIABLE}`)
}

// Where the command is: the first argument that is neither an option nor the value of one in VALUED.
function command(args: readonly string[]) {
  const at = args.findIndex((arg, index) => !arg.startsWith("-") && !VALUED.has(args[index - 1] ?? ""))
  return at === -1 ? args.length : at
}
