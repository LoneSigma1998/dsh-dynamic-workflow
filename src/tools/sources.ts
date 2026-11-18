/**
 * Script sources and drafts: an inline script is written to a draft under
 * `<cwd>/.dsh/workflow-drafts/<slug>[-N].dwf.ts` (exclusive create, one file per
 * submission) so the model revises it with `edit` and resubmits with `path`
 * instead of streaming the whole script again. Saved workflows live in
 * `<cwd>/.dsh/workflows/` (project) or `$DSH_HOME/workflows/` (global) as
 * `<name>.dwf.ts` files with a `/* dsh-workflow *\/` metadata block.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const DRAFTS_DIR = join('.dsh', 'workflow-drafts')
export const PROJECT_WORKFLOWS_DIR = join('.dsh', 'workflows')

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

export function globalWorkflowsDir(): string {
  return join(dshHome(), 'workflows')
}

export function slugOf(name: string | undefined, script: string): string {
  const fromPhase = /\bphase\(\s*["'`]([^"'`\n]+)["'`]/u.exec(script)?.[1]
  const raw = (name ?? fromPhase ?? 'workflow').trim()
  const slug = raw.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return slug.length === 0 ? 'workflow' : slug
}

/** Mint a new draft file (never overwrites). Best-effort: returns undefined when the project is not writable. */
export function writeDraft(cwd: string, name: string | undefined, script: string): string | undefined {
  try {
    const dir = join(cwd, DRAFTS_DIR)
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' })
    } catch {
      // already present
    }
    const slug = slugOf(name, script)
    for (let n = 0; n < 1000; n += 1) {
      const file = join(dir, `${slug}${n === 0 ? '' : `-${n}`}.dwf.ts`)
      try {
        writeFileSync(file, script, { encoding: 'utf8', flag: 'wx' })
        return file
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') return undefined
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

export function isDraftPath(cwd: string, path: string): boolean {
  const rel = relative(join(cwd, DRAFTS_DIR), resolve(cwd, path))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

export function readScriptFile(cwd: string, path: string): { path: string; text: string } {
  const absolute = resolve(cwd, path)
  const text = readFileSync(absolute, 'utf8')
  return { path: absolute, text: stripSavedHeader(text).script }
}

/** Model-facing path: workspace-relative when inside the workspace. */
export function describePath(cwd: string, path: string): string {
  const rel = relative(cwd, path)
  return rel.startsWith('..') || isAbsolute(rel) ? path : rel
}

// ————————————————————————————— saved workflows —————————————————————————————

export interface SavedWorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  args?: Record<string, { type?: 'string' | 'number' | 'boolean' | 'json'; description?: string; default?: unknown; required?: boolean }>
}

export interface SavedWorkflow extends SavedWorkflowMeta {
  scope: 'project' | 'global'
  path: string
  script: string
}

const HEADER = /^\s*\/\*\s*dsh-workflow\s*([\s\S]*?)\*\/\s*/u

export function stripSavedHeader(text: string): { meta?: SavedWorkflowMeta; script: string } {
  const match = HEADER.exec(text)
  if (match === null) return { script: text }
  try {
    const meta = JSON.parse(match[1]!.trim()) as SavedWorkflowMeta
    return { meta, script: text.slice(match[0].length) }
  } catch {
    return { script: text.slice(match[0].length) }
  }
}

export function renderSaved(meta: SavedWorkflowMeta, script: string): string {
  return `/* dsh-workflow\n${JSON.stringify(meta, null, 2)}\n*/\n${script.trimStart()}`
}

export function savedDir(cwd: string, scope: 'project' | 'global'): string {
  return scope === 'project' ? join(cwd, PROJECT_WORKFLOWS_DIR) : globalWorkflowsDir()
}

/** Every saved workflow of both scopes, a project one and a global one of the same name included. */
export function listSavedAll(cwd: string): SavedWorkflow[] {
  const out: SavedWorkflow[] = []
  for (const scope of ['global', 'project'] as const) {
    const dir = savedDir(cwd, scope)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.dwf.ts')) continue
      const path = join(dir, file)
      try {
        const { meta, script } = stripSavedHeader(readFileSync(path, 'utf8'))
        const name = meta?.name ?? file.slice(0, -'.dwf.ts'.length)
        out.push({ name, description: meta?.description ?? '', ...meta?.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }, ...meta?.args === undefined ? {} : { args: meta.args }, scope, path, script })
      } catch {
        // unreadable file: skip
      }
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
}

/** The saved workflows a run by name sees: a project workflow hides a global one of the same name. */
export function listSaved(cwd: string): SavedWorkflow[] {
  const out = new Map<string, SavedWorkflow>()
  for (const scope of ['global', 'project'] as const) {
    const dir = savedDir(cwd, scope)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.dwf.ts')) continue
      const path = join(dir, file)
      try {
        const { meta, script } = stripSavedHeader(readFileSync(path, 'utf8'))
        const name = meta?.name ?? file.slice(0, -'.dwf.ts'.length)
        // a project workflow hides a global one of the same name
        out.set(name, { name, description: meta?.description ?? '', ...meta?.whenToUse === undefined ? {} : { whenToUse: meta.whenToUse }, ...meta?.args === undefined ? {} : { args: meta.args }, scope, path, script })
      } catch {
        // unreadable file: skip
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** A saved workflow by name: with a scope, exactly that one (even when shadowed); without, the project one wins. */
export function findSaved(cwd: string, name: string, scope?: 'project' | 'global'): SavedWorkflow | undefined {
  return scope === undefined
    ? listSaved(cwd).find(item => item.name === name)
    : listSavedAll(cwd).find(item => item.name === name && item.scope === scope)
}

/** Validate saved-workflow arguments against their declaration and fill defaults. */
export function resolveSavedArgs(saved: SavedWorkflow, given: Record<string, unknown> | undefined): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const out: Record<string, unknown> = {}
  const declared = saved.args ?? {}
  for (const [key, spec] of Object.entries(declared)) {
    // an explicitly passed value — `null` included, a valid JSON argument — is never replaced by the default
    const value = given !== undefined && Object.hasOwn(given, key) ? given[key] : spec.default
    if (value === undefined) {
      if (spec.required === true) return { ok: false, message: `Saved workflow "${saved.name}" requires argument "${key}".` }
      continue
    }
    if (spec.type !== undefined && spec.type !== 'json' && (value === null || typeof value !== spec.type)) {
      return { ok: false, message: `Argument "${key}" of saved workflow "${saved.name}" must be a ${spec.type}.` }
    }
    out[key] = value
  }
  for (const key of Object.keys(given ?? {})) {
    if (!(key in declared)) return { ok: false, message: `Saved workflow "${saved.name}" declares no argument "${key}".` }
  }
  return { ok: true, args: out }
}

export function writeSaved(cwd: string, scope: 'project' | 'global', meta: SavedWorkflowMeta, script: string): string {
  const dir = savedDir(cwd, scope)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${slugOf(meta.name, script)}.dwf.ts`)
  writeFileSync(path, renderSaved(meta, script), 'utf8')
  return path
}
