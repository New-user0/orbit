import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261101042827_session_cost",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`lines_added\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`lines_removed\` integer;`)
      yield* tx.run(`ALTER TABLE \`session_usage\` ADD \`provider_id\` text;`)
      yield* tx.run(`ALTER TABLE \`session_usage\` ADD \`model_id\` text;`)
    })
  },
}

export default migration
