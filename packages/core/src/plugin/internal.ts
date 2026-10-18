export * as PluginInternal from "./internal.js"

import { LLMClient } from "@orbit/ai"
import type { Plugin } from "@orbit/plugin/effect/plugin"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { httpClient } from "@orbit/util/effect/app-node-platform"
import { AppProcess } from "@orbit/util/process"
import { Context, Effect, Scope } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Agent } from "../agent.js"
import { Model } from "../model.js"
import { Provider } from "../provider.js"
import { Command } from "../command.js"
import { Config } from "../config.js"
import { Credential } from "../credential.js"
import { llmClient } from "../effect/app-node-platform.js"
import { ConfigAgentPlugin } from "../config/plugin/agent.js"
import { ConfigCommandPlugin } from "../config/plugin/command.js"
import { ConfigCompactionPlugin } from "../config/plugin/compaction.js"
import { ConfigFormatterPlugin } from "../config/plugin/formatter.js"
import { ConfigImagePlugin } from "../config/plugin/image.js"
import { ConfigInstructionPlugin } from "../config/plugin/instruction.js"
import { LifecycleHooksPlugin } from "../config/plugin/lifecycle-hooks.js"
import { Lsp } from "../lsp/index.js"
import { LspPlugin } from "../lsp/plugin.js"
import { ConfigLocationWatcherPlugin } from "../config/plugin/location-watcher.js"
import { ConfigMcpPlugin } from "../config/plugin/mcp.js"
import { ConfigProviderPlugin } from "../config/plugin/provider.js"
import { ConfigPolicyPlugin } from "../config/plugin/policy.js"
import { ConfigReferencePlugin } from "../config/plugin/reference.js"
import { ConfigShellPlugin } from "../config/plugin/shell.js"
import { ConfigSnapshotPlugin } from "../config/plugin/snapshot.js"
import { ConfigSkillPlugin } from "../config/plugin/skill.js"
import { ConfigCompatibilityPlugin } from "../config/plugin/compatibility.js"
import { ConfigToolOutputPlugin } from "../config/plugin/tool-output.js"
import { ConfigWebPlugin } from "../config/plugin/web.js"
import { ConfigWebSearchPlugin } from "../config/plugin/websearch.js"
import { ConfigWorktreePlugin } from "../config/plugin/worktree.js"
import { Worktree } from "../worktree.js"
import { WorktreeStrategies } from "../worktree/strategies.js"
import { Bus } from "../bus.js"
import { Environment } from "../environment/index.js"
import { FileAccess } from "../file-access.js"
import { FileMutation } from "../file-mutation.js"
import { FileLedger } from "../file-ledger.js"
import { Formatter } from "../formatter.js"
import { Form } from "../form.js"
import { FileSystem } from "../filesystem.js"
import { LocationWatcherPolicy } from "../filesystem/location-watcher-policy.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Image } from "../image.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Integration } from "../integration.js"
import { Job } from "../job.js"
import { KV } from "../kv.js"
import { Location } from "../location.js"
import { ManagedPolicy } from "../managed-policy.js"
import { ManagedSettings } from "../managed-settings.js"
import { ModelsDev } from "../models-dev.js"
import { Mcp } from "../mcp/index.js"
import { Npm } from "@orbit/util/npm"
import { Permission } from "../permission.js"
import { ProjectTrust } from "../project-trust.js"
import { Reference } from "../reference.js"
import { WebSearch } from "../websearch.js"
import { Ripgrep } from "../ripgrep.js"
import { Session } from "../session.js"
import { SessionCompaction } from "../session/compaction.js"
import { SessionInstructions } from "../session/instructions.js"
import { InstructionTriggers } from "../instruction-triggers.js"
import { SideQuery } from "../side-query.js"
import { Shell } from "../shell.js"
import { PowerShellParse } from "../shell/powershell-parse.js"
import { ShellSelect } from "../shell/select.js"
import { Snapshot } from "../snapshot.js"
import { Skill } from "../skill.js"
import { SkillDiscovery } from "../skill/discovery.js"
import { Watcher } from "../filesystem/watcher.js"
import { PatchTool } from "../tool/plugin/patch.js"
import { EditTool } from "../tool/plugin/edit.js"
import { NotebookEditTool } from "../tool/plugin/notebook-edit.js"
import { ShellControlTools } from "../tool/plugin/shell-control.js"
import { PlanModeTools } from "../tool/plugin/plan-mode.js"
import { LspTool } from "../tool/plugin/lsp.js"
import { TaskTools } from "../tool/plugin/tasks.js"
import { WorktreeTools } from "../tool/plugin/worktree.js"
import { MemoryTool } from "../tool/plugin/memory.js"
import { GlobTool } from "../tool/plugin/glob.js"
import { GrepTool } from "../tool/plugin/grep.js"
import { McpResourceTools } from "../tool/plugin/mcp-resource.js"
import { OrbitTools } from "../tool/plugin/orbit.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"
import { ReadTool } from "../tool/plugin/read.js"
import { ShellTool } from "../tool/plugin/shell.js"
import { SkillTool } from "../tool/plugin/skill.js"
import { SubagentTool } from "../tool/plugin/subagent.js"
import { TodoTool } from "../tool/plugin/todo.js"
import { WorkflowTool } from "../tool/plugin/workflow.js"
import { Tool } from "../tool.js"
import { ToolOutput } from "../tool-output.js"
import { WebFetchTool } from "../tool/plugin/webfetch.js"
import { WebSearchTool } from "../tool/plugin/websearch.js"
import { WellKnown } from "../wellknown.js"
import { WriteTool } from "../tool/plugin/write.js"
import { AgentPlugin } from "./agent.js"
import BrowserPlugin from "@orbit/plugin-browser"
import { CommandPlugin } from "./command.js"
import { IdentityPlugin } from "./identity.js"
import { PlanPlugin } from "./plan.js"
import { ModelsDevPlugin } from "./models-dev.js"
import { McpCodeModeDefaultsPlugin } from "./mcp-codemode-defaults.js"
import { ProviderPlugins } from "./provider.js"
import { WebSearchPlugins } from "./websearch/index.js"
import { SkillPlugin } from "./skill.js"
import { VcsHgPlugin } from "./vcs/hg.js"
import { ToolInputRepairPlugin } from "./tool-input-repair.js"
import { OptimizePlugin } from "./optimize.js"
import { SubagentPromptPlugin } from "./subagent-prompt.js"
import { VcsGitPlugin } from "./vcs/git.js"
import { VerbosityPlugin } from "./verbosity.js"
import { OutputStylePlugin } from "./output-style.js"
import { PromptConfigPlugin } from "./prompt-config.js"
import { WarmingPlugin } from "./warming.js"
import { WellKnownPlugin } from "../wellknown/plugin.js"

const services = [
  Agent.Service,
  AppProcess.Service,
  Provider.Service,
  Model.Service,
  Command.Service,
  Config.Service,
  Credential.Service,
  Bus.Service,
  Environment.Service,
  FileAccess.Service,
  FileMutation.Service,
  FileLedger.Service,
  Lsp.Service,
  Formatter.Service,
  LocationWatcherPolicy.Service,
  FileSystem.Service,
  FSUtil.Service,
  Global.Service,
  HttpClient.HttpClient,
  Image.Service,
  InstructionDiscovery.Service,
  Integration.Service,
  Job.Service,
  KV.Service,
  LLMClient.Service,
  Location.Service,
  ManagedPolicy.Service,
  ManagedSettings.Service,
  ModelsDev.Service,
  Mcp.Service,
  Npm.Service,
  Permission.Service,
  ProjectTrust.Service,
  Form.Service,
  ReadToolFileSystem.Service,
  Reference.Service,
  WebSearch.Service,
  Ripgrep.Service,
  Session.Service,
  SessionCompaction.Service,
  SessionInstructions.Service,
  InstructionTriggers.Service,
  SideQuery.Service,
  Shell.Service,
  ShellSelect.Service,
  PowerShellParse.Service,
  Snapshot.Service,
  Skill.Service,
  SkillDiscovery.Service,
  Tool.Service,
  ToolOutput.Service,
  Watcher.Service,
  WellKnown.Service,
  Worktree.Service,
  WorktreeStrategies.Service,
] as const

export type Requirements = Context.Service.Identifier<(typeof services)[number]>

export const requirements = LayerNode.group([
  Agent.node,
  AppProcess.node,
  Provider.node,
  Model.node,
  Command.node,
  Config.node,
  Credential.node,
  Bus.node,
  Environment.node,
  FileAccess.node,
  FileMutation.node,
  FileLedger.node,
  Lsp.node,
  Formatter.node,
  LocationWatcherPolicy.node,
  FileSystem.node,
  FSUtil.node,
  Global.node,
  httpClient,
  Image.node,
  InstructionDiscovery.node,
  Integration.node,
  Job.node,
  KV.node,
  llmClient,
  Location.node,
  ManagedPolicy.node,
  ManagedSettings.node,
  ModelsDev.node,
  Mcp.node,
  Npm.node,
  Permission.node,
  ProjectTrust.node,
  Form.node,
  ReadToolFileSystem.node,
  Reference.node,
  WebSearch.node,
  Ripgrep.node,
  Session.node,
  SessionCompaction.node,
  SessionInstructions.node,
  InstructionTriggers.node,
  SideQuery.node,
  Shell.node,
  ShellSelect.node,
  PowerShellParse.node,
  Snapshot.node,
  Skill.node,
  SkillDiscovery.node,
  Tool.node,
  ToolOutput.node,
  Watcher.node,
  WellKnown.node,
  Worktree.node,
  WorktreeStrategies.node,
])

export type InternalPlugin = Plugin<Requirements | Scope.Scope>

const pre = [
  ToolInputRepairPlugin.Plugin,
  ConfigWorktreePlugin.Plugin,
  ConfigMcpPlugin.Plugin,
  McpCodeModeDefaultsPlugin.Plugin,
  WellKnownPlugin.Plugin,
  VcsGitPlugin.Plugin,
  AgentPlugin.Plugin,
  PlanPlugin.Plugin,
  CommandPlugin.Plugin,
  SkillPlugin.Plugin,
  VcsHgPlugin.Plugin,
  ModelsDevPlugin,
  ...ProviderPlugins,
  ...WebSearchPlugins,
  PatchTool.Plugin,
  // A subagent's base, rendered after the patch plugin selects the available editing tools. The model prompts below
  // leave a subagent alone.
  SubagentPromptPlugin.Plugin,
  // Render model prompts after the patch plugin selects the available editing tools.
  ...OptimizePlugin.Plugins,
  // After the model prompts, so the git guidance follows whichever base was chosen, and before the output style.
  PromptConfigPlugin.Plugin,
  // After the model prompts, so a style applies to whichever base prompt was chosen.
  OutputStylePlugin.Plugin,
  VerbosityPlugin.Plugin,
  IdentityPlugin.Plugin,
  EditTool.Plugin,
  NotebookEditTool.Plugin,
  ShellControlTools.Plugin,
  PlanModeTools.Plugin,
  LspTool.Plugin,
  TaskTools.Plugin,
  WorktreeTools.Plugin,
  GlobTool.Plugin,
  GrepTool.Plugin,
  OrbitTools.Plugin,
  McpResourceTools.Plugin,
  QuestionTool.Plugin,
  ReadTool.Plugin,
  ShellTool.Plugin,
  SkillTool.Plugin,
  SubagentTool.Plugin,
  TodoTool.Plugin,
  WorkflowTool.Plugin,
  WebFetchTool.Plugin,
  WebSearchTool.Plugin,
  WriteTool.Plugin,
  WarmingPlugin.Plugin,
] as const satisfies readonly InternalPlugin[]

const post = [
  ConfigInstructionPlugin.Plugin,
  // Right after the instruction files, so the memory index renders last: the later a file, the more it outranks.
  MemoryTool.Plugin,
  LifecycleHooksPlugin.Plugin,
  LspPlugin.Plugin,
  ConfigReferencePlugin.Plugin,
  ConfigAgentPlugin.Plugin,
  BrowserPlugin,
  ConfigCommandPlugin.Plugin,
  ConfigCompactionPlugin.Plugin,
  ConfigFormatterPlugin.Plugin,
  ConfigImagePlugin.Plugin,
  ConfigLocationWatcherPlugin.Plugin,
  ConfigShellPlugin.Plugin,
  ConfigSnapshotPlugin.Plugin,
  ConfigToolOutputPlugin.Plugin,
  ConfigCompatibilityPlugin.Plugin,
  ConfigSkillPlugin.Plugin,
  ConfigProviderPlugin.Plugin,
  ConfigWebPlugin.Plugin,
  ConfigWebSearchPlugin.Plugin,
  ConfigPolicyPlugin.Plugin,
  // Last, so every other hook sees the shell tool under its registry name.
  ShellTool.AdvertisePlugin,
] as const satisfies readonly InternalPlugin[]

// Repository config must not switch off policy enforcement, so plugin remove operations skip these IDs.
export const guarded: ReadonlySet<string> = new Set([ConfigPolicyPlugin.Plugin.id])

export const list = Effect.fn("PluginInternal.list")(function* () {
  // Capture only services; activation supplies the child Scope and batching context.
  const context = Context.pick(...services)(yield* Effect.context<Requirements>())
  const resolve = (plugins: readonly InternalPlugin[]) =>
    plugins.map(
      (plugin): Plugin => ({
        id: plugin.id,
        effect: (host) => plugin.effect(host).pipe(Effect.provide(context)),
      }),
    )
  return {
    pre: resolve(pre),
    post: resolve(post),
  }
})
