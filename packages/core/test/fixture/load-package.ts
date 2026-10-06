import path from "node:path"
import { Effect } from "effect"
import { Provider } from "@orbit/core/provider"
import type { Npm } from "@orbit/util/npm"

// The program that provider-compiled.test.ts compiles into a binary and starts in a folder of its own. Arguments:
// `load <package> [<npm cache>]` loads a provider package with Provider.loadPackage, and gives it an npm service that
// installs into the cache folder when one is named, and none otherwise. `import <name>` imports the name directly.
// It prints one line of JSON that says what happened.
const [mode, specifier, cache] = process.argv.slice(2)

const added: string[] = []
const unused = () => Effect.die("unused")
const npm: Npm.Interface | undefined =
  cache === undefined
    ? undefined
    : {
        add: (name) =>
          Effect.sync(() => {
            added.push(name)
            return { name, directory: path.join(cache, "node_modules", name) }
          }),
        resolve: unused,
        check: unused,
        update: unused,
        which: unused,
      }

const result =
  mode === "import"
    ? await import(specifier).then(
        () => ({ loaded: true }),
        (error) => ({ loaded: false, error: String(error) }),
      )
    : await Effect.runPromise(
        Provider.loadPackage(specifier, npm).pipe(
          Effect.match({
            onSuccess: (loaded) => ({ loaded: typeof loaded.model === "function", added }),
            onFailure: (error) => ({ loaded: false, error: String(error.cause), added }),
          }),
        ),
      )
console.log(JSON.stringify(result))
