// Part 1 of 3 of the ACP approval rows of a repository's link whose target is a share (shareMatrix in
// spelling-rows.ts): the link rows from index 0 on, four to a part, so that each file is a share of a CI shard.
// The rows need a symlink, so they run on Windows where links can be made. Each row has its own folder, model and
// `orb acp` child, and the rows run as many at a time as `--max-concurrency` allows (packages/cli/package.json).
import { linkRows } from "./approval-harness"
import { shareMatrix } from "./spelling-rows"

shareMatrix(linkRows.slice(0, 4))
