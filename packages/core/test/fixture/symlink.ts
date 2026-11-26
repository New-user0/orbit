import fs from "fs"
import os from "os"
import path from "path"

/**
 * Whether a link can be made: false only when the account is refused for lack of privilege (`EPERM`). Any other error
 * is a failed probe, not an answer, and is thrown: a file that picks its rows by this answer would otherwise lose them
 * in a run where the probe met a busy folder, a full disk or too many open files, and the run would collect fewer tests
 * than the next.
 */
export function linkProbe(link: () => void) {
  try {
    link()
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return false
    throw error
  }
}

/**
 * Whether this account can create a link to a file. Windows allows it only to a privileged account or one in developer
 * mode, and fails with EPERM otherwise. Links to a directory are another matter: a junction needs no privilege there,
 * but it cannot stand for a file.
 */
export const canLinkFile = (() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-link-probe-"))
  try {
    fs.writeFileSync(path.join(directory, "target"), "")
    return linkProbe(() => fs.symlinkSync(path.join(directory, "target"), path.join(directory, "link")))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})()
