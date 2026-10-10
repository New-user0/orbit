import os from "node:os"
import path from "node:path"

// A real /etc/orbit or %ProgramFiles%\Orbit must never reach a test: point the managed settings at a folder that does
// not exist.
process.env.ORBIT_MANAGED_DIR = path.join(os.tmpdir(), "orbit-tui-test-managed-missing")
