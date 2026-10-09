import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009073747_session_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_admission\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_admission_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_usage\` (
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`source\` text NOT NULL,
          \`cost\` real NOT NULL,
          \`tokens_input\` integer NOT NULL,
          \`tokens_output\` integer NOT NULL,
          \`tokens_reasoning\` integer NOT NULL,
          \`tokens_cache_read\` integer NOT NULL,
          \`tokens_cache_write\` integer NOT NULL,
          CONSTRAINT \`session_usage_pk\` PRIMARY KEY(\`session_id\`, \`seq\`),
          CONSTRAINT \`fk_session_usage_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_admission_session_idx\` ON \`session_admission\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_usage_time_idx\` ON \`session_usage\` (\`time_created\`);`)
      // A database that kept its events (a persisted Bus) carries history that the new table would otherwise lack.
      yield* tx.run(`
        INSERT OR IGNORE INTO \`session_usage\`
        SELECT e.aggregate_id, e.seq, e.created,
          CASE WHEN substr(e.type, 1, 27) = 'session.side_query.recorded' THEN 'side_query' ELSE 'usage' END,
          coalesce(json_extract(e.data, '$.source'), json_extract(e.data, '$.purpose'), ''),
          coalesce(json_extract(e.data, '$.cost'), 0),
          coalesce(json_extract(e.data, '$.tokens.input'), 0),
          coalesce(json_extract(e.data, '$.tokens.output'), 0),
          coalesce(json_extract(e.data, '$.tokens.reasoning'), 0),
          coalesce(json_extract(e.data, '$.tokens.cache.read'), 0),
          coalesce(json_extract(e.data, '$.tokens.cache.write'), 0)
        FROM \`event\` AS e JOIN \`session_v2\` AS s ON s.id = e.aggregate_id
        WHERE substr(e.type, 1, 22) = 'session.usage.recorded'
          OR substr(e.type, 1, 27) = 'session.side_query.recorded'
      `)
    })
  },
}

export default migration
