import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261024071601_session_removed",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_removed\` (
          \`id\` text PRIMARY KEY
        );
      `)
    })
  },
}

export default migration
