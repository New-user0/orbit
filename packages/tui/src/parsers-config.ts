// Grammars are never fetched at runtime. Markdown, JavaScript and TypeScript use the renderer's built-in
// parsers; further languages need their .wasm grammar and .scm queries bundled locally (file paths work).
export default {
  parsers: [],
}
