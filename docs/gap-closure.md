# Gap closure tracker

Closing the gaps found by comparing Orbit with Claude Code's public documentation. Every item is built from public
docs, open standards and Orbit's own code. A step is ticked once it is committed with tests and `bun run check` passes.

## W1. System prompts

- [x] Fuller default system prompt (`core/src/session/runner/prompt/system.txt`)
- [x] Per-tool guidance for the full tool set
- [x] Shared rules appended to every model-specific prompt
- [x] Short prompt for local models
- [x] Expanded Explore agent prompt

## W2. Output styles

- [x] `output_style` config with built-in and Markdown-file styles
- [x] Output style picker in the TUI (`/output-style`) and VS Code (Orbit: Choose Output Style)

## W3. Safe defaults and instruction files

- [x] Load `ORBIT.md`, `AGENTS.md` or `CLAUDE.md`, first one per directory
- [ ] Ask before edits and shell commands by default — blocked by the session's safety classifier; needs the owner
- [ ] Auto-allow read-only shell commands — blocked, as above
- [ ] Flow agents approve edits inside their own worktrees — blocked, as above

## W4. File tools

- [x] grep output modes, context lines, file types, multiline, paging
- [x] glob sorted newest first
- [x] Read before edit, write or patch
- [x] Read notebooks as cells; `notebook_edit` tool

## W5. Background commands

- [x] `Shell.kill` and `POST /api/shell/:id/kill`
- [x] `shell_output`, `shell_watch`, `shell_stop` tools
- [x] ~~Keep the working directory between shell calls~~ — decided against: a `cd` would silently move later commands outside the project, around the external-directory checks. Commands use `workdir` instead.

## W6. Plan mode

- [x] `enter_plan_mode` and `exit_plan_mode` with approval form
- [x] VS Code answers server forms (question tool, plan approval)
- [x] Shell commands in plan mode need the user's approval (without the read-only allowlist from W3, every command asks)

## W7. Settings hooks

- [x] `hooks` config: PreToolUse, PostToolUse, UserPromptSubmit, SessionStart, Stop, PreCompact
- [x] Read hooks from `.claude/settings.json` and `settings.local.json`

## W8. Language servers

- [x] LSP client and Location-scoped service (configured or on-PATH servers, no downloads)
- [x] Errors added to edit results
- [x] `lsp` tool: definition, references, hover, symbols, diagnostics

## W9. Platform

- [x] Task tools with ids and dependencies
- [x] Worktree tools
- [x] WebFetch `prompt` option; WebSearch domain filters
- [x] MCP SSE transport
- [x] Headless `--format stream-json|result`, `--json-schema`, `--bare`
- [x] TUI `/context`, status line command, vim mode
- [x] Auto memory
- [x] Sandboxed shell (opt-in)
- [x] `orb loop`
