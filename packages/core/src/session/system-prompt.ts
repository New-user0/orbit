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
    tool: "Bash",
    lines: [
      "- Prefer dedicated tools over shell commands; fall back to Bash when a tool cannot do what you need. Do not use Bash to read, search, or edit files when Read, Grep, Glob, or Edit are available.",
      "- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.",
      "- Quote paths that contain spaces. Prefer absolute paths over changing directories.",
      "- Run long-lived processes such as dev servers and watchers with `run_in_background`, then check on them instead of waiting for them to exit.",
    ],
  },
  {
    tool: "TaskOutput",
    lines: [
      "- Use TaskOutput to read new output from a background command, TaskWatch to wait for a line to appear, and TaskStop to end a command you started.",
    ],
  },
  {
    tool: "Read",
    lines: [
      "- Use Read to look at files before you change them. Read a large file in ranges with `offset` and `limit` instead of all at once. It also reads images, Jupyter notebooks and PDFs; a PDF of more than 10 pages must be read in ranges with `pages`, at most 20 pages per call.",
    ],
  },
  {
    tool: "Grep",
    lines: [
      "- Use Grep to search file contents with a regular expression. Set `outputMode` to list matching files or counts when you do not need the lines themselves, and ask for context lines when you need surrounding code.",
    ],
  },
  {
    tool: "Glob",
    lines: ["- Use Glob to find files by name pattern. Results are sorted with the most recently modified first."],
  },
  {
    tool: "Write",
    lines: [
      "- Use Write to create files or completely replace their content. Prefer Edit for targeted changes. Read an existing file before you overwrite it.",
    ],
  },
  {
    tool: "Edit",
    lines: [
      "- Use Edit for targeted changes to existing text files. It replaces the exact text in `old_string` with `new_string`, and the two must differ. By default `old_string` must occur exactly once. If it occurs several times, include more surrounding context to make it unique, or set `replace_all` to true to replace every occurrence.",
      "- Read a file before you edit it, and read it again if it may have changed since. Copy `old_string` from the Read output without the line-number prefix.",
    ],
  },
  {
    tool: "NotebookEdit",
    lines: [
      "- Use NotebookEdit to replace, insert, or delete cells in a Jupyter notebook instead of editing its JSON.",
    ],
  },
  {
    tool: "TodoWrite",
    lines: [
      "- Use TodoWrite for work with three or more steps. Mark one item in progress at a time and complete each item as soon as it is done.",
    ],
  },
  {
    tool: "TaskCreate",
    lines: [
      "- For long work with dependent steps, use TaskCreate, TaskUpdate and TaskList instead of TodoWrite: record dependencies with `blockedBy` and start a task only when the tasks it depends on are completed.",
    ],
  },
  {
    tool: "Memory",
    lines: [
      "- Use Memory to save what a future session in this project should know, such as working build and test commands, conventions, and the user's stated preferences. Keep memories short and current.",
    ],
  },
  {
    tool: "Agent",
    lines: [
      "- Use Agent to delegate broad searches or self-contained tasks, so their intermediate output stays out of this conversation. Give the agent everything it needs in the prompt, and launch independent agents together.",
    ],
  },
  {
    tool: "WebFetch",
    lines: [
      "- Use WebFetch to ask a question about a specific URL, and put exactly what you need from the page in its prompt. Do not guess URLs; use ones the user gave you or ones you found in the project or search results.",
    ],
  },
  {
    tool: "EnterPlanMode",
    lines: [
      "- When a task is large or the right approach is unclear, use EnterPlanMode to research and write a plan before changing files.",
    ],
  },
  {
    tool: "ExitPlanMode",
    lines: [
      "- In plan mode, research without changing files, then call ExitPlanMode with the finished plan to ask the user for approval.",
    ],
  },
]
