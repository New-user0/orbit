export * as OrbitWorkerd from "./workerd"

import { Layer } from "effect"
import type { Config, Scope } from "effect"
import { WorkerdProfile } from "../internal/workerd"
import { Orbit } from "./orbit"

export type Configuration = WorkerdProfile.Configuration

export interface CreateOptions<R = never> extends WorkerdProfile.Options {
  readonly log?: Orbit.CreateOptions["log"]
  readonly workspaceProviders?: Orbit.CreateOptions["workspaceProviders"]
  readonly instances?: Orbit.CreateOptions<R>["instances"]
}

export const create = <R = never>({ log, workspaceProviders, instances, ...options }: CreateOptions<R>) => {
  const profile = WorkerdProfile.make(options)
  return Orbit.create(
    { ...profile.options, log, workspaceProviders, instances },
    { overrides: profile.replacements },
  )
}

export const layer = <R = never>(
  options: CreateOptions<R>,
): Layer.Layer<Orbit.Service, Config.ConfigError | Error, Exclude<R, Scope.Scope>> =>
  Layer.effect(Orbit.Service, create(options))

export type Interface = Orbit.Interface
export type Requirements = Scope.Scope
