// The workflow and suite doors: files that bring code, commands or approvals are not loaded, run or approved in a folder
// nothing trusts. Split from trust-doors.test.ts (the overlay doors) so that each file fits well inside the runner's file
// deadline. The scripted model, the shared root and the helpers are in fixture/trust-harness.ts; every `orb` here runs
// without ORBIT_TRUST_PROJECT, so a folder is trusted only when a grant says so, and each test uses a repository of its own.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { quoted, refusal } from "../src/util/trust"
import {
  model,
  runs,
  root,
  workflow,
  suite,
  hooked,
  bare,
  traced,
  noop,
  oneTask,
  marked,
  orb,
  succeeded,
} from "./fixture/trust-harness"

test("orb flow run --trust and orb flow resume --trust grant for their own run only", async () => {
  const repository = await hooked("flows")

  const started = await orb(repository, ["flow", "run", "--trust", "--standalone", workflow])
  succeeded(started)
  expect(started.stdout).toContain("done")
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id

  const refused = await orb(repository, ["flow", "resume", "--standalone", id])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("is not trusted")
  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
}, 240_000)

test("a workflow or suite file is not loaded, so none of its code runs, before the trust check", async () => {
  const repository = await hooked("load-order")
  const marker = path.join(root, "work", "load-order.marker")
  // The top-level code of a file leaves a trace when the file is imported, as the code of any workflow or suite does.
  const traced = (body: string) =>
    `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "loaded")\n${body}\n`
  const flowFile = path.join(root, "work", "load-order-flow.ts")
  const suiteFile = path.join(root, "work", "load-order-suite.ts")
  await Bun.write(flowFile, traced(`export default { name: "traced", run: () => "done" }`))
  await Bun.write(
    suiteFile,
    traced(
      `export default { name: "traced", models: ["${model}"], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }`,
    ),
  )

  const started = await orb(repository, ["flow", "run", "--standalone", flowFile])
  const evaluated = await orb(repository, ["eval", suiteFile, "--standalone"])

  for (const result of [started, evaluated]) {
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("is not trusted")
  }
  expect(await Bun.file(marker).exists()).toBe(false)

  // A resumed run names its workflow file in the repository's own run store, so that file is the one it must not import.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", flowFile]))
  expect(await Bun.file(marker).exists()).toBe(true)
  await fs.rm(marker)
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id
  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])
  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain("is not trusted")
  expect(await Bun.file(marker).exists()).toBe(false)
}, 360_000)

test("a workflow or suite module is not imported in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("modules")
  const flowModule = await traced(repository, "workflow.ts", noop)
  const suiteModule = await traced(repository, "suite.ts", oneTask)
  const before = runs

  const started = await orb(repository, ["flow", "run", "--standalone", flowModule.file])
  const evaluated = await orb(repository, ["eval", suiteModule.file, "--standalone"])

  for (const [result, module] of [
    [started, flowModule],
    [evaluated, suiteModule],
  ] as const) {
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${repository} is not trusted`)
    // It says the command runs code from the folder, names the file, and gives both ways to trust the folder.
    expect(result.stderr).toContain("runs code from the folder")
    expect(result.stderr).toContain(path.basename(module.file))
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
    // Nothing is held back, so there is no list of files to name.
    expect(result.stderr).not.toContain("holds back")
    // The code in the file never ran.
    expect(await Bun.file(module.marker).exists()).toBe(false)
  }
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run: the modules are imported and run.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", flowModule.file]))
  expect(await Bun.file(flowModule.marker).exists()).toBe(true)
  succeeded(await orb(repository, ["eval", suiteModule.file, "--trust", "--standalone"]))
  expect(await Bun.file(suiteModule.marker).exists()).toBe(true)
  expect(runs).toBeGreaterThan(before)
}, 360_000)

test("a recorded run's workflow module is not imported by resume or replay in an untrusted folder that holds nothing back", async () => {
  const repository = await bare("recorded")
  const module = await traced(repository, "workflow.ts", noop)
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", module.file]))
  // The run store, which sits in the repository, names the module a resume or a replay loads.
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id
  await fs.rm(module.marker)

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])
  const replayed = await orb(repository, ["flow", "replay", "--standalone", id])

  // Both go on from the run store, so the folder stops them before the store is read and the module is known.
  for (const result of [resumed, replayed]) {
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${repository} is not trusted`)
    expect(result.stderr).toContain("goes on from a run that the folder's run store")
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
  }
  expect(await Bun.file(module.marker).exists()).toBe(false)

  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
  expect(await Bun.file(module.marker).exists()).toBe(true)
  await fs.rm(module.marker)
  const trusted = await orb(repository, ["flow", "replay", "--trust", "--standalone", id])
  succeeded(trusted)
  expect(trusted.stderr).toContain(`replay matches the recorded output of ${id}`)
  expect(await Bun.file(module.marker).exists()).toBe(true)
}, 360_000)

test("a YAML workflow stops in an untrusted folder, as orb run does, and resuming or replaying its run needs the folder trusted", async () => {
  const repository = await bare("yaml")
  const file = path.join(repository, "workflow.yaml")
  await Bun.write(file, "name: pause\nnodes:\n  - id: approve\n    type: gate\n    message: Go on?\n")

  // Loading it runs no code, but no work starts in a folder that is not trusted, whatever the file defines.
  const refused = await orb(repository, ["flow", "run", "--standalone", file])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(`${repository} is not trusted`)
  // With --trust the run goes ahead and stops at its gate, which needs no model.
  const started = await orb(repository, ["flow", "run", "--trust", "--standalone", file])

  expect(started.code).toBe(2)
  expect(started.stderr).toContain("approve: Go on?")
  expect(started.stderr).not.toContain("is not trusted")
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id
  succeeded(await orb(repository, ["flow", "approve", "--standalone", "--trust", id, "approve"]))
  // A resume and a replay go on from the run store, which a clone can ship, so the folder stops them.
  for (const args of [
    ["flow", "resume", "--standalone", id],
    ["flow", "replay", "--standalone", id],
  ]) {
    const refused = await orb(repository, args)
    expect({ args, code: refused.code }).toEqual({ args, code: 1 })
    expect(refused.stderr).toContain(`${repository} is not trusted`)
  }
  // A replay asks a server whether the folder is trusted, so one that cannot be reached stops it as well.
  const unreachable = await orb(repository, ["flow", "replay", id, "--server", "http://127.0.0.1:9"])
  expect(unreachable.code).toBe(1)
  expect(unreachable.stderr).not.toContain("replay matches")
  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
  const replayed = await orb(repository, ["flow", "replay", "--trust", "--standalone", id])
  succeeded(replayed)
  expect(replayed.stderr).toContain(`replay matches the recorded output of ${id}`)
}, 360_000)

test("a workflow or suite that defines shell commands is not run in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("commands")
  const check = marked("check-node")
  const verify = marked("verify-checks")
  const task = marked("task-checks")
  const flowFile = path.join(repository, "workflow.yaml")
  const verifyFile = path.join(repository, "verify.yaml")
  const suiteFile = path.join(repository, "suite.json")
  await Bun.write(flowFile, `name: commands\nnodes:\n  - id: tests\n    type: check\n    command: ${check.quoted}\n`)
  await Bun.write(
    verifyFile,
    `name: verifies\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    checks:\n      - ${verify.quoted}\n`,
  )
  await Bun.write(
    suiteFile,
    JSON.stringify({
      name: "commands",
      tasks: [{ id: "task", prompt: "say ok", checks: [task.command] }],
    }),
  )
  const before = runs

  // Reading these files runs nothing, and the folder holds nothing back, but a run of each executes a shell command:
  // a check node, the checks of a verify node, and the checks of a suite task.
  const attempts = [
    [await orb(repository, ["flow", "run", "--standalone", flowFile]), flowFile, "tests", check],
    [await orb(repository, ["flow", "run", "--standalone", verifyFile]), verifyFile, "work", verify],
    [await orb(repository, ["eval", suiteFile, "--standalone"]), suiteFile, "task", task],
  ] as const

  for (const [result, file, id, command] of attempts) {
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${repository} is not trusted`)
    // It says the command runs shell commands from the folder, names the file and lists what it found by node or task,
    // and gives both ways to trust the folder.
    expect(result.stderr).toContain("runs shell commands from the folder")
    expect(result.stderr).toContain(`${path.basename(file)} defines them`)
    expect(result.stderr).toContain(`  ${id}  ${command.command}`)
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
    // Nothing is held back, so there is no list of files to name.
    expect(result.stderr).not.toContain("holds back")
    // The command never ran.
    expect(await Bun.file(command.marker).exists()).toBe(false)
  }
  // No agent did any work either.
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run: the commands of each file run.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", flowFile]))
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", verifyFile]))
  succeeded(await orb(repository, ["eval", suiteFile, "--trust", "--standalone"]))
  for (const command of [check, verify, task]) expect(await Bun.file(command.marker).exists()).toBe(true)
  expect(runs).toBeGreaterThan(before)

  // A resumed eval goes on from the run store as well, so the folder stops it before the store or the suite is read.
  const recorded: Array<{ id: string; workflow: string }> = JSON.parse(
    (await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout,
  )
  const evalRun = recorded.find((run) => run.workflow.startsWith("eval:"))?.id
  expect(evalRun).toBeString()
  await fs.rm(task.marker)
  const resumed = await orb(repository, ["eval", suiteFile, "--resume", String(evalRun), "--standalone"])
  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain(`${repository} is not trusted`)
  expect(resumed.stderr).toContain("goes on from a run that the folder's run store")
  expect(await Bun.file(task.marker).exists()).toBe(false)
}, 360_000)

test("a recorded YAML run's commands are not run again by resume in an untrusted folder, and a trusted replay runs none of them", async () => {
  const repository = await bare("recorded-commands")
  const check = marked("recorded-check")
  const file = path.join(repository, "workflow.yaml")
  await Bun.write(file, `name: recorded\nnodes:\n  - id: tests\n    type: check\n    command: ${check.quoted}\n`)
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", file]))
  expect(await Bun.file(check.marker).exists()).toBe(true)
  await fs.rm(check.marker)
  // The run store, which sits in the repository, names the file that a resume loads.
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain(`${repository} is not trusted`)
  expect(await Bun.file(check.marker).exists()).toBe(false)
  // A replay answers every check from the recording, so even with the folder trusted it runs none.
  const replayed = await orb(repository, ["flow", "replay", "--trust", "--standalone", id])
  succeeded(replayed)
  expect(replayed.stderr).toContain(`replay matches the recorded output of ${id}`)
  expect(await Bun.file(check.marker).exists()).toBe(false)

  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
  expect(await Bun.file(check.marker).exists()).toBe(true)
}, 360_000)
