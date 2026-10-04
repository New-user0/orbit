export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

export function make(tools: string[]) {
  return render(PROMPT, tools)
}

export function render(prompt: string, tools: string[]) {
  const instructions = GUIDANCE.filter((entry) => tools.includes(entry.tool)).flatMap((entry) => entry.lines)
  return prompt.replace("${ORBIT_TOOL_GUIDANCE}", instructions.join("\n"))
}

const GUIDANCE = [
  {
    tool: "shell",
    lines: [
      "- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need. Do not use the shell to read, search, or edit files when the read, grep, glob, or edit tools are available.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
      "- Quote paths that contain spaces. Prefer absolute paths over changing directories.",
      "- Run long-lived processes such as dev servers and watchers in the background, then check on them instead of waiting for them to exit.",
    ],
  },
  {
    tool: "shell_output",
    lines: [
      "- Use shell_output to read new output from a background command, shell_watch to wait for a line to appear, and shell_stop to end a command you started.",
    ],
  },
  {
    tool: "read",
    lines: [
      "- Use the read tool to read files before you change them. Read a large file in ranges with an offset and limit instead of all at once. It also reads images and Jupyter notebooks.",
    ],
  },
  {
    tool: "grep",
    lines: [
      "- Use the grep tool to search file contents with a regular expression. Use `outputMode` to list matching files or counts when you do not need the lines themselves, and context lines when you need surrounding code.",
    ],
  },
  {
    tool: "glob",
    lines: [
      "- Use the glob tool to find files by name pattern. Results are sorted with the most recently modified first.",
    ],
  },
  {
    tool: "write",
    lines: [
      "- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes. Read an existing file before you overwrite it.",
    ],
  },
  {
    tool: "edit",
    lines: [
      "- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
      "- Read a file before you edit it, and read it again if it may have changed since. Copy `oldString` from the read output without the line-number prefix.",
    ],
  },
  {
    tool: "notebook_edit",
    lines: [
      "- Use the notebook_edit tool to replace, insert, or delete cells in a Jupyter notebook instead of editing its JSON.",
    ],
  },
  {
    tool: "todo",
    lines: [
      "- Use the todo tool for work with three or more steps. Mark one item in progress at a time and complete each item as soon as it is done.",
    ],
  },
  {
    tool: "task_create",
    lines: [
      "- For long work with dependent steps, use task_create, task_update and task_list instead of todo: record dependencies with blockedBy and start a task only when the tasks it depends on are completed.",
    ],
  },
  {
    tool: "memory",
    lines: [
      "- Use the memory tool to save what a future session in this project should know, such as working build and test commands, conventions, and the user's stated preferences. Keep memories short and current.",
    ],
  },
  {
    tool: "subagent",
    lines: [
      "- Use the subagent tool to delegate broad searches or self-contained tasks, so their intermediate output stays out of this conversation. Give the subagent everything it needs in the prompt, and launch independent subagents together.",
    ],
  },
  {
    tool: "webfetch",
    lines: [
      "- Use the webfetch tool to read a specific URL. Do not guess URLs; use ones the user gave you or ones you found in the project or search results.",
    ],
  },
  {
    tool: "enter_plan_mode",
    lines: [
      "- When a task is large or the right approach is unclear, use enter_plan_mode to research and write a plan before changing files.",
    ],
  },
  {
    tool: "exit_plan_mode",
    lines: [
      "- In plan mode, research without changing files, then call exit_plan_mode with the finished plan to ask the user for approval.",
    ],
  },
]
