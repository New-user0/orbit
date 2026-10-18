export * as AgentPlugin from "./agent.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import { Permission } from "../permission.js"

const PROMPT_EXPLORE = `You are a read-only search agent. Another agent sent you to find something in this codebase and report back. Your report is all it will see, so make it complete and precise.

# How to search
- Start broad, then narrow. Use Glob to find candidate files by name, Grep to find symbols and strings, and Read to confirm what you found.
- Run independent searches in parallel. Try several naming conventions and spellings when the first search misses.
- Follow the code: once you find a definition, look for its callers, its tests, and where it is configured.
- Match your effort to the thoroughness the caller asked for. A quick lookup needs one or two searches; a thorough survey should check every likely location before concluding something does not exist.

# Rules
- You are read-only. Do not create, edit, move, or delete files, and do not run shell commands that change anything.
- Do not guess. If you could not find something, say so and list where you looked.
- Avoid emojis.

# Report
- Lead with the direct answer to the question.
- Cite evidence as absolute paths with line numbers, for example \`/repo/src/server.ts:42\`, with a short excerpt when it helps.
- Note anything surprising or contradictory you came across, and open questions the caller should check.
- Keep it as short as the answer allows. Do not paste whole files.`

const PROMPT_TITLE = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- <=50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "Read tool", "Bash tool", "Edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  -> create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" -> Debugging production 500 errors
"refactor user service" -> Refactoring user service
"why is app.js failing" -> app.js failure investigation
"implement rate limiting" -> Rate limiting implementation
"how do I connect postgres to my API" -> Postgres API connection
"best practices for React hooks" -> React hooks best practices
"@src/credential.ts can you add refresh token support" -> Credential refresh token support
"@utils/parser.ts this is broken" -> Parser bug fix
"look at @config.json" -> Config review
"@App.tsx add dark mode toggle" -> Dark mode toggle in App
</examples>`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

export const Plugin = define({
  id: "orbit.agent",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      editor.update(Agent.defaultID, (item) => {
        item.name = Agent.Name.make("Build")
        item.description = "The default agent. Executes tools based on configured permissions."
        item.mode = "primary"
        item.permissions.push({ action: "AskUserQuestion", resource: "*", effect: "allow" })
      })

      editor.update(Agent.ID.make("general"), (item) => {
        item.name = Agent.Name.make("General")
        item.description =
          "General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel."
        item.mode = "subagent"
        item.permissions.push(
          { action: "AskUserQuestion", resource: "*", effect: "deny" },
          { action: "Agent", resource: "*", effect: "deny" },
        )
      })

      editor.update(Agent.ID.make("explore"), (item) => {
        const externalDirectories = item.permissions.filter(
          (rule) => rule.action === "external_directory" && rule.effect === "allow",
        )
        item.name = Agent.Name.make("Explore")
        item.description =
          'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.'
        item.system = PROMPT_EXPLORE
        item.mode = "subagent"
        // Its rules deny everything else; this is what the agent listing tells the model it can use.
        item.tools = { allow: ["Grep", "Glob", "Read", "WebFetch", "WebSearch"] }
        // It only reads: the project's instruction files, the memory index and the start-of-session git snapshot are
        // left out of its baseline to spare tokens. Set either key to true in `agents.explore.context` to bring it back.
        item.context = { instructions: false, git_status: false }
        item.permissions.push(
          ...Permission.merge(
            [
              { action: "*", resource: "*", effect: "deny" },
              { action: "Grep", resource: "*", effect: "allow" },
              { action: "Glob", resource: "*", effect: "allow" },
              { action: "WebFetch", resource: "*", effect: "allow" },
              { action: "WebSearch", resource: "*", effect: "allow" },
              { action: "Read", resource: "*", effect: "allow" },
              { action: "Read", resource: "*.env", effect: "ask" },
              { action: "Read", resource: "*.env.*", effect: "ask" },
              { action: "Read", resource: "*.env.example", effect: "allow" },
              { action: "Agent", resource: "*", effect: "deny" },
            ],
            [Agent.defaultAsk({ action: "external_directory", resource: "*", effect: "ask" as const }), ...externalDirectories],
          ),
        )
      })

      editor.update(Agent.ID.make("compaction"), (item) => {
        item.name = Agent.Name.make("Compaction")
        item.mode = "primary"
        item.hidden = true
      })

      editor.update(Agent.ID.make("title"), (item) => {
        item.name = Agent.Name.make("Title")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })

      // One-shot side queries (SideQuery). It has no system prompt of its own, because each caller writes one, and
      // `agents.side.model` pins the model they use.
      editor.update(Agent.ID.make("side"), (item) => {
        item.name = Agent.Name.make("Side")
        item.mode = "primary"
        item.hidden = true
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })

      editor.update(Agent.ID.make("summary"), (item) => {
        item.name = Agent.Name.make("Summary")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })
    })
  }),
})
