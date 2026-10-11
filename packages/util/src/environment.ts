export * as Environment from "./environment.js"

/**
 * Writes `values` into `target` name by name. On Windows a name is one variable whatever its case, and a plain object
 * keeps `Path` and `PATH` as two keys that different programs read differently (`cmd.exe` takes the last, Bun the first),
 * so a name first removes every spelling of itself already in `target`. Elsewhere names are compared exactly.
 */
export function assign<V extends string | undefined>(
  target: Record<string, V>,
  values: Readonly<Record<string, V>>,
  platform: NodeJS.Platform = process.platform,
) {
  Object.entries(values).forEach(([name, value]) => {
    if (platform === "win32") {
      const lower = name.toLowerCase()
      Object.keys(target)
        .filter((key) => key !== name && key.toLowerCase() === lower)
        .forEach((key) => delete target[key])
    }
    // A defined property for the one name that plain assignment would send to the prototype.
    if (name === "__proto__")
      Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true })
    else target[name] = value
  })
  return target
}
