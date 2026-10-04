import { expect, test } from "bun:test"
import { Location as CoreLocation } from "@orbit/core/location"
import { SessionInbox as CoreSessionInbox } from "@orbit/core/session/inbox"
import { SessionMessage as CoreSessionMessage } from "@orbit/core/session/message"
import { Agent } from "@orbit/schema/agent"
import { Config } from "@orbit/schema/config"
import { Event } from "@orbit/schema/event"
import { Location } from "@orbit/schema/location"
import { Model } from "@orbit/schema/model"
import { Project } from "@orbit/schema/project"
import { Provider } from "@orbit/schema/provider"
import { WebSearch } from "@orbit/schema/websearch"
import { Session } from "@orbit/schema/session"
import { SessionInbox } from "@orbit/schema/session-inbox"
import { SessionMessage } from "@orbit/schema/session-message"
import { Workspace } from "@orbit/schema/workspace"
import { Worktree } from "@orbit/schema/worktree"
import { Api } from "@orbit/server/api"
import { ClientApi, groupNames, promiseOmitEndpoints } from "@orbit/protocol/client"
import { compile, emitPromise } from "@orbit/httpapi-codegen"

const SDK = await import("../src/index")
const CoreAgent = await import("@orbit/core/agent")
const CoreModel = await import("@orbit/core/model")
const CoreProject = await import("@orbit/core/project")
const CoreSession = await import("@orbit/core/session")
const CoreWorktree = await import("@orbit/core/worktree")

test("re-exports canonical contracts directly from Schema", () => {
  expect(SDK.Agent).toBe(Agent)
  expect(SDK.Config).toBe(Config)
  expect(SDK.Event).toBe(Event)
  expect(SDK.Model).toBe(Model)
  expect(SDK.WebSearch).toBe(WebSearch)
  expect(SDK.Session).toBe(Session)
  expect(SDK.Worktree).toBe(Worktree)
  expect(SDK.Workspace).toBe(Workspace)
  expect(Object.keys(SDK).sort()).toEqual([
    "AbsolutePath",
    "Agent",
    "ClientError",
    "Command",
    "Config",
    "Credential",
    "Event",
    "FileSystem",
    "Integration",
    "Location",
    "Model",
    "Orbit",
    "Permission",
    "PermissionSaved",
    "Project",
    "Prompt",
    "PromptInput",
    "Provider",
    "Pty",
    "Question",
    "Reference",
    "RelativePath",
    "Session",
    "SessionInbox",
    "SessionMessage",
    "Skill",
    "Tool",
    "WebSearch",
    "Workspace",
    "Worktree",
  ])
})

test("Core and Server reuse the authoritative Schema and Protocol values", () => {
  expect(CoreAgent.ID).toBe(Agent.ID)
  expect(CoreLocation.Ref).toBe(Location.Ref)
  expect(CoreModel.Ref).toBe(Model.Ref)
  expect(CoreSession.Info).toBe(Session.Info)
  expect(CoreProject.Current).toBe(Project.Current)
  expect(CoreWorktree.DirectoryUnavailableError).toBeDefined()
  expect(CoreWorktree.List).toBe(Worktree.List)
  expect(CoreWorktree.Info).toBe(Worktree.Info)
  expect(CoreSessionInbox.Item).toBe(SessionInbox.Item)
  expect(CoreSessionInbox.User).toBe(SessionInbox.User)
  expect(CoreSessionInbox.Synthetic).toBe(SessionInbox.Synthetic)
  expect(CoreSessionMessage.Info).toBe(SessionMessage.Info)
  expect(CoreSessionMessage.AssistantText).toBe(SessionMessage.AssistantText)
  expect(Api.groups["server.session"].identifier).toBe("server.session")
  expect(Api.groups["server.project"].identifier).toBe("server.project")
  expect(Object.keys(ClientApi.groups)).toEqual(Object.keys(Api.groups))
  expect(Session.ID.create()).toStartWith("ses_")
  expect(String(Project.ID.global)).toBe("global")
  expect(String(Provider.ID.anthropic)).toBe("anthropic")
  expect(Workspace.ID.create()).toStartWith("wrk_")
})

test("client and Server contracts generate identically", () => {
  const server = compile(Api, { groupNames, omitEndpoints: promiseOmitEndpoints })
  const client = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })

  expect(emitPromise(client)).toEqual(emitPromise(server))
})
