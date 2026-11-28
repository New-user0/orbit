import fs from "node:fs"
import path from "node:path"

// Run by test/filesystem/directory-watch.test.ts as a process of its own, as an install or a checkout is: writes `count` files
// into node_modules below the folder in a burst, then one real file.
const [directory, count] = [process.argv[2]!, Number(process.argv[3])]
fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true })
for (let index = 0; index < count; index++) fs.writeFileSync(path.join(directory, "node_modules", `f${index}.js`), "x")
fs.writeFileSync(path.join(directory, "real.txt"), "r")
