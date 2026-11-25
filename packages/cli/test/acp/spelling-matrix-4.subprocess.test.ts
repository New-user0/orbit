// Part 4 of 4 of the ACP approval rows of a repository's link into the person's config folder through each real
// spelling of the workspace folder (spellingMatrix in spelling-rows.ts): the link rows from index 9 on, three to a
// part, so that each file is a share of a CI shard. Each row has its own folder, model and `orb acp` child, and the
// rows run as many at a time as `--max-concurrency` allows (packages/cli/package.json).
import { linkRows } from "./approval-harness"
import { spellingMatrix } from "./spelling-rows"

spellingMatrix(linkRows.slice(9))
