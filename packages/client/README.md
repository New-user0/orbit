# @orbit/client

Private generation target for clients derived directly from Orbit's authoritative Effect `HttpApi`.

## Entrypoints

- `@orbit/client`: zero-Effect Promise client using `fetch`.
- `@orbit/client/effect`: rich Effect network client using an environment-provided `HttpClient`.

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@orbit/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@orbit/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core or Effect runtime dependency. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce both import graphs.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, Orbit, Prompt } from "@orbit/client/effect"

const client = yield * Orbit.make({ baseUrl: "https://orbit.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```

## Starting the service

When no server runs, the client can start one with `options.command`, which defaults to `["orb", "serve", "--service"]`. That default names a program without a folder, and the client starts it through `node:child_process` because client runtime code may depend only on Schema and Protocol, so it has no lookup of its own. On Windows a program started by a bare name is looked for in the working folder of the host before `PATH`, so a host that runs in a folder it does not control can start an `orb.exe` that the folder holds. A host on Windows therefore passes an absolute command, for example `["C:\Program Files\Orbit\orb.exe", "serve", "--service"]`, or starts its own process with the environment variable `NoDefaultCurrentDirectoryInExePath` set. This is documented rather than enforced (FU-M1-075; see "Known gaps" in `docs/untrusted-repositories.md`).
