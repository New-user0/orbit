import path from "path"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"

/**
 * The real filesystem service and a Global service whose directories all live under `root`, so a test never creates
 * anything in the machine's own data, cache or config directories.
 */
export const services = (root: string, home: string) =>
  LayerNode.compile(LayerNode.group([FSUtil.node, Global.node]), {
    replacements: [
      Global.node.replace(
        Global.layerWith({
          home,
          config: path.join(root, "config"),
          data: path.join(root, "data"),
          cache: path.join(root, "cache"),
          state: path.join(root, "state"),
          tmp: path.join(root, "tmp"),
          bin: path.join(root, "bin"),
          log: path.join(root, "log"),
          repos: path.join(root, "repos"),
        }),
      ),
    ],
  })

/** Whether `target` is `root` or inside it. The machine running a test may keep roots of its own above the fixture. */
export function inFixture(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
