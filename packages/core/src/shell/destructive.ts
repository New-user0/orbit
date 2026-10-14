export * as ShellDestructive from "./destructive.js"

import type { ShellAnalysis } from "./analysis.js"

// A fixed catalogue of commands that lose data or are hard to undo, matched on the raw command text with no parse, so
// it never depends on a parser, an environment or a working folder. The first match wins. It is advisory: it decides
// no permission, only how much caution a consumer adds. A later warning reads the same entries through `find`, so the
// trait and the warning cannot disagree.

type Entry = { key: string; test: (text: string) => boolean }

const pattern = (key: string, source: RegExp, flags = ""): Entry => {
  const regex = new RegExp(source.source, [...new Set(source.flags + flags)].join(""))
  return { key, test: (text) => regex.test(text) }
}

// A forced `git clean` that does not also ask for a dry run, in a short-flag cluster or as a long option.
const gitClean = (flags: string): Entry => {
  const clean = new RegExp(String.raw`\bgit\s+clean\b([^;&|\n]*)`, `g${flags}`)
  return {
    key: "git-clean-force",
    test: (text) => {
      // Every `git clean` in the text counts, so an earlier dry run does not hide a later forced one.
      return [...text.matchAll(clean)].some(
        (match) =>
          /\s(?:--force|-[A-Za-z]*f[A-Za-z]*)(?![\w-])/.test(match[1]) &&
          !/\s(?:--dry-run|-[A-Za-z]*n[A-Za-z]*)(?![\w-])/.test(match[1]),
      )
    },
  }
}

// The git and SQL rules both dialects share. PowerShell matches them without regard to case.
const shared = (flags: string) => ({
  reset: pattern("git-reset-hard", /\bgit\s+reset\b[^;&|\n]*\s--hard(?![\w-])/, flags),
  push: pattern("git-push-force", /\bgit\s+push\b[^;&|\n]*\s(?:--force(?:-with-lease)?|-f)(?![\w-])/, flags),
  clean: gitClean(flags),
  stash: pattern("git-stash-drop", /\bgit\s+stash\s+(?:drop|clear)\b/, flags),
  drop: pattern("sql-drop", /\b(?:drop|truncate)\s+(?:table|database|schema)\b/, "i"),
})

const posixShared = shared("")
const powershellShared = shared("i")

// `rm` only at the start of a command, with its first argument a short-flag cluster: wrappers such as `sudo rm`, long
// options and flags after the first argument are not matched.
const posix: Entry[] = [
  posixShared.reset,
  posixShared.push,
  posixShared.clean,
  pattern("git-checkout-all", /\bgit\s+checkout\s+(?:--\s+)?\.\s*(?:$|[;&|\n)])/),
  pattern("git-restore-all", /\bgit\s+restore\s+(?:--\s+)?\.\s*(?:$|[;&|\n)])/),
  posixShared.stash,
  pattern("git-branch-delete", /\bgit\s+branch\s+(?:[^;&|\n]*\s)?-D(?![\w-])/),
  pattern("git-branch-delete", /\bgit\s+branch\b(?=[^;&|\n]*\s--delete(?![\w-]))[^;&|\n]*\s--force(?![\w-])/),
  pattern("git-no-verify", /\bgit\s+(?:commit|push|merge)\b[^;&|\n]*\s--no-verify(?![\w-])/),
  pattern("git-amend", /\bgit\s+commit\b[^;&|\n]*\s--amend(?![\w-])/),
  pattern("rm-recursive-force", /(?:^|[;&|\n])[ \t]*rm[ \t]+-(?=[A-Za-z]*[rR])(?=[A-Za-z]*f)[A-Za-z]+(?![\w-])/),
  pattern("rm-recursive", /(?:^|[;&|\n])[ \t]*rm[ \t]+-[A-Za-z]*[rR][A-Za-z]*(?![\w-])/),
  pattern("rm-force", /(?:^|[;&|\n])[ \t]*rm[ \t]+-[A-Za-z]*f[A-Za-z]*(?![\w-])/),
  posixShared.drop,
  pattern("sql-delete-all", /\bdelete\s+from\s+[\w.]+[ \t]*(?:$|[;"'\n])/i),
  pattern("kubectl-delete", /\bkubectl\s+delete\b/),
  pattern("terraform-destroy", /\bterraform\s+destroy\b/),
]

const powershell: Entry[] = [
  // A statement ends at `|`, `;`, `&`, a newline or `}`; a `)` does not end it, so flags after a parenthesised path count.
  pattern(
    "remove-item",
    /(?:^|[|;&\n({])\s*(?:remove-item|rm|del|rd|rmdir|ri)(?=\s)[^|;&\n}]*\s-(?:recurse|force)(?![\w-])/,
    "i",
  ),
  pattern("clear-content-wildcard", /\bclear-content\b[^|;&\n]*\*/, "i"),
  pattern("format-volume", /\b(?:format-volume|clear-disk)\b/, "i"),
  powershellShared.reset,
  powershellShared.push,
  powershellShared.clean,
  powershellShared.stash,
  powershellShared.drop,
  pattern("shutdown", /\b(?:stop-computer|restart-computer|clear-recycle-?bin)\b/, "i"),
]

/** The category key of the first catalogue entry the command text matches, or undefined. */
export function find(command: string, dialect: Exclude<ShellAnalysis.Dialect, "unanalysed">) {
  return (dialect === "bash" ? posix : powershell).find((entry) => entry.test(command))?.key
}

/**
 * Whether the command text is in the catalogue. A shell Orbit has no catalogue for (cmd.exe and any unanalysed shell)
 * cannot be called harmless, so every command under it is destructive.
 */
export function matches(command: string, dialect: ShellAnalysis.Dialect) {
  if (dialect === "unanalysed") return true
  return find(command, dialect) !== undefined
}
