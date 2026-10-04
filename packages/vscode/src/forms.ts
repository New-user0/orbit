import vscode from "vscode"
import type { FormField, FormRequest } from "./protocol.js"

type Value = string | boolean | number | string[]

const OTHER = "Type your own answer…"
// Longer descriptions, such as a plan to approve, open beside the chat instead of squeezing into a picker.
const INLINE_LIMIT = 200

/**
 * Asks each field of a server form with VS Code's own pickers and input boxes. Returns undefined when the user
 * dismisses any of them, which cancels the whole form.
 */
export async function askForm(form: FormRequest): Promise<Record<string, Value> | undefined> {
  const answer: Record<string, Value> = {}
  for (const field of form.fields.filter((item) => item.type !== "external" && !item.hidden)) {
    if (field.description && field.description.length > INLINE_LIMIT) {
      const document = await vscode.workspace.openTextDocument({ content: field.description, language: "markdown" })
      await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: true })
    }
    const value = await askField(form.title, field)
    if (value === undefined) return undefined
    answer[field.key] = value
  }
  return answer
}

async function askField(title: string, field: FormField): Promise<Value | undefined> {
  const prompt = field.title ?? field.key
  const placeHolder = !field.description
    ? prompt
    : field.description.length <= INLINE_LIMIT
      ? field.description
      : `${prompt} (shown beside)`
  if (field.type === "boolean") {
    const picked = await vscode.window.showQuickPick(["Yes", "No"], { title, placeHolder, ignoreFocusOut: true })
    return picked === undefined ? undefined : picked === "Yes"
  }
  if (field.type === "multiselect") {
    const picked = await vscode.window.showQuickPick(
      (field.options ?? []).map((option) => ({
        label: option.label,
        description: option.description,
        value: option.value,
      })),
      { title, placeHolder, canPickMany: true, ignoreFocusOut: true },
    )
    return picked?.map((item) => item.value)
  }
  if (field.type === "number" || field.type === "integer") {
    const typed = await vscode.window.showInputBox({
      title,
      prompt: placeHolder,
      ignoreFocusOut: true,
      validateInput: (text) => (Number.isFinite(Number(text)) ? undefined : "Enter a number"),
    })
    return typed === undefined ? undefined : Number(typed)
  }
  if (field.options && field.options.length > 0) {
    const items = [
      ...field.options.map((option) => ({ label: option.label, description: option.description, value: option.value })),
      ...(field.custom ? [{ label: OTHER, description: undefined, value: OTHER }] : []),
    ]
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true })
    if (picked?.value !== OTHER) return picked?.value
  }
  return vscode.window.showInputBox({ title, prompt: placeHolder, ignoreFocusOut: true })
}
