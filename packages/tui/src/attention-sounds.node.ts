import { fileURLToPath } from "node:url"

const resolve = (name: string) => fileURLToPath(new URL(`./assets/audio/${name}`, import.meta.url))

export const defaultSoundPath = resolve("bip-bop-01.mp3")
export const questionSoundPath = resolve("bip-bop-03.mp3")
export const permissionSoundPath = resolve("staplebops-06.mp3")
export const errorSoundPath = resolve("nope-03.mp3")
export const subagentDoneSoundPath = resolve("yup-01.mp3")
