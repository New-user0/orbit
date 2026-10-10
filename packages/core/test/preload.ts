import os from "node:os"
import path from "node:path"

process.env.ORBIT_DB = ":memory:"
// A real /etc/orbit or %ProgramData%\Orbit must never reach a test: point the managed settings at a folder that does
// not exist. Tests that exercise them pass their own directory.
process.env.ORBIT_MANAGED_DIR = path.join(process.env.ORBIT_TEST_HOME ?? os.tmpdir(), "orbit-managed-missing")
process.env.NPM_CONFIG_AUDIT = "false"
// Tests write project config next to the code under test, so the default node graph trusts every folder. Trust
// behavior is covered where a test builds WorkspaceTrust with `implicit: false`.
process.env.ORBIT_TRUST_PROJECT = "1"
// A Git Bash terminal exports SHELL=/bin/bash.exe, which the shell tool honours, but the tests send PowerShell
// commands on win32. Clear it so the shell files give the same result from any terminal.
if (process.platform === "win32") delete process.env.SHELL
