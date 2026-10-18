// The file that an editor's Orbit bridge writes so that a terminal UI in the same window can find it, and the few
// constants both ends share. It is plain TypeScript with no Effect and no editor API, so the VS Code extension bundles it
// and the terminal UI reads it. The terminal UI decodes a lock it reads with its own schema before it trusts a field.
import crypto from "node:crypto"
import path from "node:path"
import { roots } from "./global-roots.js"

export namespace IdeLock {
  /** What a bridge writes to `<state>/ide/<port>.lock`. The port in the body must be the one in the file name. */
  export type Lock = {
    version: 1
    /** The process whose death makes the lock stale: the editor's extension host. */
    pid: number
    port: number
    workspaceFolders: string[]
    ideName: string
    authToken: string
  }

  /** The version of the lock file and of the message set. A reader that meets another one skips the file. */
  export const version = 1

  /** The header that carries the token on the WebSocket upgrade. A browser page cannot set it, and a URL never holds it. */
  export const header = "x-orbit-ide-token"

  /** The application close code a bridge uses to refuse a client that speaks another version. */
  export const closeVersion = 4001

  /** The shape of a token: 32 random bytes in base64url. The reader checks it before the value goes into a header. */
  export const tokenPattern = /^[A-Za-z0-9_-]{43}$/

  /** The most characters of selected text that go on the wire. The range that goes with it stays exact. */
  export const selectionTextCap = 100_000

  /** The largest frame, in bytes, that the terminal UI takes from a bridge. */
  export const frameCap = 1_048_576

  /** The most bytes of a lock file that a reader takes. */
  export const lockCap = 65_536

  /** The folder that holds the locks. The terminal UI computes the same folder from its own state path. */
  export function directory() {
    return path.join(roots("orbit").state, "ide")
  }

  export function file(folder: string, port: number) {
    return path.join(folder, `${port}.lock`)
  }

  /** Only a name of digits and `.lock` is a lock; the number is the port. */
  export function port(name: string) {
    const match = /^(\d{1,5})\.lock$/.exec(name)
    return match ? Number(match[1]) : undefined
  }

  export function token() {
    return crypto.randomBytes(32).toString("base64url")
  }
}
