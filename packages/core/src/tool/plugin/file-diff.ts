import { FileDiff } from "@orbit/schema/file-diff"
import { plainPath } from "@orbit/util/plain"
import { createTwoFilesPatch, diffLines } from "diff"

export function fileDiff(
  file: string,
  before: string,
  after: string,
  status: typeof FileDiff.Info.Type.status = "modified",
): typeof FileDiff.Info.Type {
  const counts = diffLines(before, after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  // A header is one line: a break in a name would end it, and a client draws a patch it cannot parse as its raw text,
  // where the rest of the name is a line of its own (class 9). `file` keeps the name as it is.
  const header = file.replace(/\r?\n|[\r\u2028\u2029]/g, plainPath)
  return {
    file,
    patch: createTwoFilesPatch(header, header, before, after),
    status,
    ...counts,
  }
}
