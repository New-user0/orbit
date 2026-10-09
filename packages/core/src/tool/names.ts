/**
 * The alias table that maps the old built-in tool names and input fields to the reference ones. It lives in
 * `@orbit/schema` so the clients that draw a recorded call read the same table; core code imports it from here.
 */
export { ToolNames } from "@orbit/schema/tool-names"
