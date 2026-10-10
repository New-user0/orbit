// The lexical device check runs before any file system call (resolving a path stats every part of it, and a stat of a
// device can block), so an external device path touches nothing. Deleting that check leaves the check after resolve,
// which refuses the same names, but only after the stats: this pins the order (class 14, class 15).
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FileAccess } from "@orbit/core/file-access"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity } from "./lib/tool"

describe("FileAccess.authorizeRead device order", () => {
  for (const trusted of [true, false])
    it.live(`refuses a device before any file system call (${trusted ? "trusted" : "untrusted"})`, () =>
      Effect.gen(function* () {
        const project = (yield* tmpdirScoped()).path
        const device = process.platform === "win32" ? "C:\\Windows\\COM1" : "/dev/zero"
        const recorded = recordedFileSystem()
        yield* Effect.gen(function* () {
          const access = yield* FileAccess.Service
          recorded.touched.length = 0
          const error = yield* access
            .authorizeRead(device, {
              ...toolIdentity,
              sessionID: Session.ID.make("ses_device_order"),
              id: Tool.CallID.make("call-device-order"),
            })
            .pipe(Effect.flip)
          expect(error).toBeInstanceOf(FileAccess.DeviceError)
          expect(recorded.touched).toEqual([])
        }).pipe(
          Effect.provide(
            AppNodeBuilder.build(LayerNode.group([FileAccess.node, Location.node, ProjectTrust.node]), [
              Location.node.replace(
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                ),
              ),
              Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
              ...(trusted ? [] : untrustedProjectNodes),
              FSUtil.node.replace(recorded.layer),
            ]),
          ),
        )
      }).pipe(Effect.scoped),
    )
})
