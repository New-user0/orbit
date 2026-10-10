export * as ConfigSandbox from "./sandbox.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.Sandbox")({
  enabled: Schema.Boolean.pipe(optional).annotate({
    description:
      "Run shell commands in an OS sandbox: bubblewrap (bwrap) on Linux, sandbox-exec on macOS. Commands can then write only to the project, the temporary directory and the paths in write. A command fails if the sandbox tool is missing. WSL2 is supported like Linux, and a sandboxed command there cannot start Windows programs (cmd.exe, powershell.exe) because the WSL interop sockets are hidden; WSL1 cannot sandbox, so commands fail there. Windows has no sandbox, so commands run as usual there.",
  }),
  network: Schema.Boolean.pipe(optional).annotate({
    description: "Allow sandboxed commands to use the network (default false)",
  }),
  write: Schema.String.pipe(Schema.Array, optional).annotate({
    description: "Extra directories sandboxed commands may write to",
  }),
}) {}
