/**
 * A folder name as one argument of a command that a person pastes into a shell, or undefined when no quoting is safe.
 * A name comes from a folder that a repository chose, so it may hold `$(...)`, backticks, quotes or control characters:
 * it is quoted so that no shell expands it, and a name that cannot be quoted that way gets no command at all.
 *
 * POSIX shells take a name in single quotes, which expand nothing. On Windows the command is typed in PowerShell or
 * cmd, which share only double quotes, so a name is printed only when it holds nothing either would expand.
 */
export function shellArgument(value: string, platform: NodeJS.Platform = process.platform): string | undefined {
  // Controls, line breaks, bidirectional marks and unassigned code points would hide or reshape the command.
  if (value === "" || /[\p{C}\p{Zl}\p{Zp}]/u.test(value)) return undefined
  if (platform === "win32") {
    if (/^[\w.,:\\/@+=-]+$/.test(value)) return value
    return /^[\w .,:\\/@+=()-]+$/.test(value) ? `"${value}"` : undefined
  }
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}
