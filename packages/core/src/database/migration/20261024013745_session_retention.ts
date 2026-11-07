import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// The time this migration's row in the journal records is when retention started on this database:
// `SessionRetention` counts no session idle from before it. A new database records its creation.
const migration: DatabaseMigration.Migration = {
  id: "20261024013745_session_retention",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_stats_archive\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`subagent\` integer NOT NULL,
          \`bucket\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`provider_id\` text,
          \`model_id\` text,
          \`variant\` text,
          \`name\` text,
          \`status\` text,
          \`count\` integer NOT NULL,
          \`cost\` real NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`tokens_reasoning\` integer NOT NULL,
          \`tokens_cache_read\` integer NOT NULL,
          \`tokens_cache_write\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`session_stats_archive_session_idx\` ON \`session_stats_archive\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_stats_archive_bucket_idx\` ON \`session_stats_archive\` (\`bucket\`);`)
    })
  },
}

export default migration
