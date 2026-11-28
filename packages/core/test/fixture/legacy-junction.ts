import os from "node:os"

// Windows keeps the folder names of older versions as system junctions on the system drive: `C:\Documents and Settings`
// leads to `C:\Users`, and a profile's `Local Settings` to its `AppData\Local`. A spelling through them names a folder
// only below a profile's `AppData\Local`, where the temporary folder of a developer's machine is. Windows CI keeps its
// temporary folder on D: (check.yml) and names the runner's own one on C: in ORBIT_TEST_OTHER_VOLUME, so the rows that
// spell a folder through these junctions make that folder there. The class 3 and 4 spelling gates take the folder
// from `junctionTemporary()`, and each has a Windows row that fails when `junctionSpellings` gives it none.
const profileLocal = /^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\/i

/** A temporary folder below a profile's AppData\Local, or undefined when there is none (and off Windows). */
export const junctionTemporary = () =>
  process.platform === "win32"
    ? [os.tmpdir(), process.env.ORBIT_TEST_OTHER_VOLUME].find(
        (folder): folder is string => folder !== undefined && profileLocal.test(`${folder}\\`),
      )
    : undefined

/** The spellings of `folder` through each legacy junction that leads to it. */
export const junctionSpellings = (folder: string) =>
  process.platform === "win32"
    ? [
        {
          name: "Documents and Settings",
          spelled: folder.replace(/^([A-Za-z]:)\\Users\\/i, "$1\\Documents and Settings\\"),
        },
        {
          name: "Local Settings",
          spelled: folder.replace(/^(.*?\\Users\\[^\\]+)\\AppData\\Local\\/i, "$1\\Local Settings\\"),
        },
      ].filter((item) => item.spelled !== folder)
    : []
