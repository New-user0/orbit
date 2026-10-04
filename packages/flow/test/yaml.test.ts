import { expect, test } from "bun:test"
import { validate, type Spec } from "../src/yaml"

const spec = (nodes: Spec["nodes"], output?: string): Spec => ({ name: "w", nodes, ...(output ? { output } : {}) })

test("a valid graph passes", () => {
  const nodes = validate(
    spec([
      { id: "plan", prompt: "Plan {{input.task}}" },
      { id: "api", needs: ["plan"], prompt: "Do {{plan.text}}" },
      { id: "tests", type: "check", needs: ["api"], command: "npm test", in: "api" },
      { id: "merge", type: "merge", needs: ["tests"], branches: ["api"] },
    ]),
    "w.yaml",
  )
  expect([...nodes.keys()]).toEqual(["plan", "api", "tests", "merge"])
})

test("every problem in a graph is reported before anything runs", () => {
  expect(() =>
    validate(
      spec(
        [
          { id: "a", needs: ["c"], prompt: "x" },
          { id: "b", needs: ["a"], prompt: "{{a.text}} and {{z.text}}" },
          { id: "c", needs: ["b"], prompt: "x" },
          { id: "c", prompt: "again" },
          { id: "d", type: "deploy" as never, needs: ["nope"] },
          { id: "e", type: "check" },
          { id: "f", type: "merge", branches: ["a"] },
        ],
        "missing",
      ),
      "w.yaml",
    ),
  ).toThrow(
    [
      "w.yaml is not a valid workflow:",
      "- node id c is used twice",
      "- d: unknown type deploy",
      "- d needs nope, which is not a node",
      "- e: needs a command",
      "- cycle: a → c → b → a",
      "- output missing is not a node",
    ].join("\n"),
  )
})

test("a node may only use results of nodes it needs, directly or through others", () => {
  expect(() =>
    validate(
      spec([
        { id: "plan", prompt: "p" },
        { id: "api", needs: ["plan"], prompt: "{{plan.text}}" },
        { id: "ui", prompt: "{{api.text}}" },
        { id: "merge", type: "merge", needs: ["api"], branches: ["api", "plan", "ui"] },
      ]),
      "w.yaml",
    ),
  ).toThrow(
    [
      "- ui uses api, which is not among the nodes it needs",
      "- merge uses ui, which is not among the nodes it needs",
    ].join("\n"),
  )
})
