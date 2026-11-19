/**
 * Runtime values from the Host's own DSH modules. The plugin bundle may not carry its own copy of
 * a host package (module identity, versioned formats), so these are imported dynamically from the
 * Host's module graph once at load, with conservative fallbacks when a module is absent.
 */

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

type AppendPluginRecord = (session: unknown, type: string, data: unknown) => unknown
type BuildForkSeed = (events: readonly SessionEvent[], boundary: number) => SessionEvent[]

interface HostModules {
  /** `@deepseek-ai/dsh-session#appendPluginRecord`; null when unavailable. */
  appendPluginRecord: AppendPluginRecord | null
  /** `@deepseek-ai/dsh-session#buildForkSeed`; null when unavailable. */
  buildForkSeed: BuildForkSeed | null
  /** `@deepseek-ai/dsh-subagent#SUBAGENT_DESCRIPTOR_VERSION` (3 in DSH 0.2.2). */
  subagentDescriptorVersion: number
}

let modules: HostModules | undefined
const waiting: (() => void)[] = []

/**
 * A plugin installed with `dsh plugin add` resolves host packages through its profile. One loaded
 * by path (`insert: [{ name: '/…/lib/index.js' }]`) has no node_modules of its own: resolve the
 * package from the Host's entry script instead. The file URL is the one the Host itself imported,
 * so this is the Host's module instance, not a copy.
 */
async function importOptional(specifier: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await import(specifier) as Record<string, unknown>
  } catch { /* not resolvable from the plugin's own location */ }
  const entry = process.argv[1]
  if (entry === undefined) return undefined
  try {
    const resolved = createRequire(realpathSync(entry)).resolve(specifier)
    return await import(pathToFileURL(resolved).href) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export async function loadHostModules(): Promise<HostModules> {
  if (modules !== undefined) return modules
  const [session, sessionFork, subagent] = await Promise.all([
    importOptional('@deepseek-ai/dsh-session'),
    importOptional('@deepseek-ai/dsh-session/fork'),
    importOptional('@deepseek-ai/dsh-subagent'),
  ])
  const buildForkSeedCandidate = sessionFork?.buildForkSeed ?? session?.buildForkSeed
  modules = {
    appendPluginRecord: typeof session?.appendPluginRecord === 'function' ? session.appendPluginRecord as AppendPluginRecord : null,
    buildForkSeed: typeof buildForkSeedCandidate === 'function' ? buildForkSeedCandidate as BuildForkSeed : null,
    subagentDescriptorVersion: typeof subagent?.SUBAGENT_DESCRIPTOR_VERSION === 'number' ? subagent.SUBAGENT_DESCRIPTOR_VERSION : 3,
  }
  for (const resume of waiting.splice(0)) resume()
  return modules
}

/** The loaded host modules, or undefined while the dynamic imports are still in flight. */
export function hostModules(): HostModules | undefined {
  return modules
}

/** Run `task` once the host modules are loaded (immediately when they are). */
export function whenHostModules(task: () => void): void {
  if (modules !== undefined) task()
  else waiting.push(task)
}
