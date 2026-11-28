import { expect, test } from "bun:test"
import path from "node:path"
import { APPROVAL_ROW_LIMIT, approvalRowTimes } from "./approval-harness"

// The ACP approval rows are gate rows of classes 3, 4 and 8, so a CI run never excuses one that runs out of time. Each
// row's limit covers its wait for a start slot as well as its work, so it is the measured one in approval-harness.ts:
// at least twice the slowest row CI recorded. A row that keeps a limit of its own, such as the 90 s these rows had
// before the slowest reached 54.89 s, fails here (class 14).
const files = ["spelling-rows.ts", "permission-files.subprocess.test.ts", "permission-spellings.subprocess.test.ts"]

test("every ACP approval row has the measured limit, at least twice the slowest row CI recorded", async () => {
  expect(APPROVAL_ROW_LIMIT).toBeGreaterThanOrEqual(2 * approvalRowTimes.slowest * 1000)
  const rows = await Promise.all(
    files.map(async (file) => {
      const text = await Bun.file(path.join(import.meta.dir, file)).text()
      return {
        file,
        rows: text.match(/test\.concurrent\(/g)?.length ?? 0,
        // The limit is the argument after the row's function, whose call closes on the line before it.
        measured: text.match(/\),\r?\n\s*APPROVAL_ROW_LIMIT,\r?$/gm)?.length ?? 0,
      }
    }),
  )
  expect(rows.map((item) => item.rows).every((count) => count > 0)).toBe(true)
  expect(rows).toEqual(rows.map((item) => ({ ...item, measured: item.rows })))
})
