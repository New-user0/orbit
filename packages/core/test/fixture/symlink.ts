import fs from "fs"
import os from "os"
import path from "path"

/**
 * Whether this account can create a link to a file. Windows allows it only to a privileged account or one in developer
 * mode, and fails with EPERM otherwise. Links to a directory are another matter: a junction needs no privilege there,
 * but it cannot stand for a file.
 */
export const canLinkFile = (() => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-link-probe-"))
  try {
    fs.writeFileSync(path.join(directory, "target"), "")
    fs.symlinkSync(path.join(directory, "target"), path.join(directory, "link"))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})()
