// The ACP approval rows of a repository's link into the person's config folder through each real spelling of the
// workspace folder, for the link rows after the Bash ones (PowerShell, Grep, Glob, Read and Write); the Bash rows are in
// permission-spellings.subprocess.test.ts. Each row has its own folder, model and `orb acp` child, and the rows run as
// many at a time as `--max-concurrency` allows. The file does not sort beside the other one, so CI's `--shard`, which
// gives each job a run of files in path order, does not start both in one job.
import { linkRows } from "./acp/approval-harness"
import { spellingMatrix } from "./acp/spelling-rows"

spellingMatrix(linkRows.slice(5))
