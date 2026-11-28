import type { TrustStatus } from "@orbit/client"

/**
 * Whether the folder needs an answer from the person, which is what the question and the indicator are for: it is not
 * trusted, whatever it holds, because nothing a folder supplies loads and no work starts there until it is
 * (trust-first). A trusted folder is never asked about again, whatever changed in it since the grant, as the reference
 * does (D8), and so is one that a server older than this client still lists changes for.
 */
export function asksTrust(status: TrustStatus | undefined) {
  return status !== undefined && !status.trusted
}

/**
 * What the plugin and theme loaders need from one read of the startup folder's status. A read that did not come back
 * (unset) is an untrusted folder, so nothing of the project loads on an answer that was not there. `root` is the folder
 * the server decided trust for, which bounds the terminal UI's own walk where it is the narrower one (class 3).
 */
export function pluginTrust(status: TrustStatus | undefined) {
  return { trusted: status?.trusted === true, root: status?.directory }
}
