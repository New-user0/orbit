import { Database } from "@orbit/core/database/database"
import { ModelsDev } from "@orbit/core/models-dev"
import { PersistentPty } from "@orbit/core/persistent-pty"
import { Schema } from "effect"

export const ServerOptions = Schema.Struct({
  app: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      channel: Schema.optional(Schema.String),
    }),
  ),
  hostname: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535))),
  password: Schema.optional(Schema.String),
  cors: Schema.optional(Schema.Array(Schema.String)),
  simulation: Schema.optional(Schema.Boolean),
  database: Schema.optional(Database.Options),
  pty: Schema.optional(PersistentPty.Options),
  events: Schema.optional(
    Schema.Struct({
      persist: Schema.optional(Schema.Boolean),
    }),
  ),
  models: Schema.optional(ModelsDev.Options),
  config: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      project: Schema.optional(Schema.Boolean),
      file: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
    }),
  ),
  managed: Schema.optional(
    Schema.Struct({
      // Where the managed settings files are read from. Unset means the per-OS default, or ORBIT_MANAGED_DIR for a
      // host that reads the environment. The folder is read, never created.
      directory: Schema.optional(Schema.String),
    }),
  ),
  trust: Schema.optional(
    Schema.Struct({
      // Trust every folder except the home directory and filesystem roots, without a grant. Unset means false, whatever
      // ORBIT_TRUST_PROJECT holds: that variable is for the `orb` command to read, for the servers it starts itself.
      implicit: Schema.optional(Schema.Boolean),
    }),
  ),
  windows: Schema.optional(
    Schema.Struct({
      gitbash: Schema.optional(Schema.String),
    }),
  ),
  fs: Schema.optional(
    Schema.Struct({
      filewatcher: Schema.optional(Schema.Boolean),
      fff: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type ServerOptions = typeof ServerOptions.Type
