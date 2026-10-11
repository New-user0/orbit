import { Agent } from "@orbit/core/agent"
import { AISDK } from "@orbit/core/aisdk"
import { Command } from "@orbit/core/command"
import { Config } from "@orbit/core/config"
import { Credential } from "@orbit/core/credential"
import { LayerNodePlatform } from "@orbit/util/effect/app-node-platform"
import { AppProcess } from "@orbit/util/process"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Bus } from "@orbit/core/bus"
import { FileSystem } from "@orbit/core/filesystem"
import { FSUtil } from "@orbit/util/fs-util"
import { Form } from "@orbit/core/form"
import { Generate } from "@orbit/core/generate"
import { Integration } from "@orbit/core/integration"
import { KV } from "@orbit/core/kv"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Mcp } from "@orbit/core/mcp/index"
import { Model } from "@orbit/core/model"
import { Npm } from "@orbit/util/npm"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Provider } from "@orbit/core/provider"
import { Session } from "@orbit/core/session"
import { PersistentPty } from "@orbit/core/persistent-pty"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Permission } from "@orbit/core/permission"
import { ProjectTrust } from "@orbit/core/project-trust"
import { FileAccess } from "@orbit/core/file-access"
import { PowerShellParse } from "@orbit/core/shell/powershell-parse"
import { Reference } from "@orbit/core/reference"
import { Rpc } from "@orbit/core/rpc"
import { Skill } from "@orbit/core/skill"
import { SkillDiscovery } from "@orbit/core/skill/discovery"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Tool } from "@orbit/core/tool"
import { Vcs } from "@orbit/core/vcs"
import { WebSearch } from "@orbit/core/websearch"
import { Worktree } from "@orbit/core/worktree"
import { WorktreeStrategies } from "@orbit/core/worktree/strategies"
import { Effect, Layer } from "effect"
import { tempLocationLayer } from "../fixture/location"
import { emptyMcpLayer } from "../fixture/mcp"
import { trustedProject } from "../fixture/project-trust"

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) => Effect.succeed({ directory: "", name }),
    resolve: (name) => Effect.succeed({ directory: "", name }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: "", name }),
    which: () => Effect.undefined,
  }),
)

const generateLayer = Layer.succeed(Generate.Service, Generate.Service.of({ text: () => Effect.succeed("") }))

const permissionLayer = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    close: Effect.void,
    ask: (input) => Effect.succeed({ id: input.id ?? Permission.ID.create(), effect: "ask" }),
    assert: () => Effect.void,
    denied: () => Effect.succeed(false),
    reply: () => Effect.void,
    get: () => Effect.succeed(undefined),
    forSession: () => Effect.succeed([]),
    list: () => Effect.succeed([]),
    callOf: () => Effect.succeed(undefined),
  }),
)

export const PluginTestLayer = AppNodeBuilder.build(
  LayerNode.group([
    AppProcess.node,
    FileSystem.node,
    FSUtil.node,
    Location.node,
    Npm.node,
    Credential.node,
    Bus.node,
    Form.node,
    Generate.node,
    LayerNodePlatform.httpClient,
    Plugin.node,
    Agent.node,
    AISDK.node,
    Provider.node,
    Model.node,
    Command.node,
    Integration.node,
    KV.node,
    ManagedPolicy.node,
    Mcp.node,
    Session.node,
    PersistentPty.node,
    LocationServiceMap.node,
    FileAccess.node,
    Permission.node,
    PowerShellParse.node,
    ProjectTrust.node,
    PluginHooks.node,
    Reference.node,
    Rpc.node,
    Skill.node,
    SkillDiscovery.node,
    Tool.node,
    Vcs.node,
    Watcher.node,
    WebSearch.node,
    Worktree.node,
    WorktreeStrategies.node,
  ]),
  [
    Location.node.replace(tempLocationLayer),
    Npm.node.replace(npmLayer),
    Config.node.replace(Config.testLayer()),
    Mcp.node.replace(emptyMcpLayer),
    Generate.node.replace(generateLayer),
    Permission.node.replace(permissionLayer),
    ProjectTrust.node.replace(trustedProject),
  ],
)
