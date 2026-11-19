/**
 * Node implementations of the two narrow ports ZCode's world-read executor
 * (`world-read.ts`, ported verbatim) talks to: a file-system port for
 * `files.glob/read/grep` and an execution port for `git.*` and `world.run`.
 * They spawn real processes with a fixed argv (never a shell) in the run's
 * captured working directory, prefer ripgrep when it is installed, and fall
 * back to plain Node otherwise.
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

// ————————————————————————————— port shapes (subset of @zcode/contracts) —————————————————————————————

export interface ExecutionOutputLimit {
  maxInlineBytes: number
  tailBytes?: number
}

export interface ExecutionStreamResult {
  text: string
  bytes: number
  truncated: boolean
  tail?: string
}

export interface ExecutionResult {
  status: 'completed' | 'failed' | 'timed_out' | 'spawn_error' | 'cancelled'
  exitCode?: number
  error?: { message: string }
  stdout: ExecutionStreamResult
  stderr: ExecutionStreamResult
}

export interface ExecutionPort {
  run(input: {
    command: { mode: 'argv'; file: string; args: string[] }
    cwd: string
    timeoutMs?: number
    outputLimit: ExecutionOutputLimit
    signal?: AbortSignal
  }): Promise<ExecutionResult>
}

export interface FileSystemPort {
  searchFiles(input: { path: string; pattern: string; maxResults: number }): Promise<{ files: string[]; truncated: boolean }>
  readTextFile(input: { path: string }): Promise<{ content: string }>
  searchText(input: {
    path: string
    pattern: string
    glob?: string
    outputMode: 'content'
    showLineNumbers: boolean
    headLimit: number
  }): Promise<{ entries: { path: string; lineNumber?: number; text?: string }[]; truncated: boolean }>
}

// ————————————————————————————— execution —————————————————————————————

class StreamCollector {
  private chunks: Buffer[] = []
  private inline = 0
  bytes = 0
  truncated = false
  private tailChunks: Buffer[] = []
  private tailSize = 0

  constructor(private readonly limit: ExecutionOutputLimit) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.length
    if (this.inline < this.limit.maxInlineBytes) {
      const room = this.limit.maxInlineBytes - this.inline
      const piece = chunk.length <= room ? chunk : chunk.subarray(0, room)
      this.chunks.push(piece)
      this.inline += piece.length
      if (piece.length < chunk.length) this.truncated = true
    } else if (chunk.length > 0) {
      this.truncated = true
    }
    if (this.limit.tailBytes !== undefined) {
      this.tailChunks.push(chunk)
      this.tailSize += chunk.length
      while (this.tailSize - (this.tailChunks[0]?.length ?? 0) >= this.limit.tailBytes && this.tailChunks.length > 1) {
        this.tailSize -= this.tailChunks.shift()!.length
      }
    }
  }

  result(): ExecutionStreamResult {
    const out: ExecutionStreamResult = { text: Buffer.concat(this.chunks).toString('utf8'), bytes: this.bytes, truncated: this.truncated }
    if (this.limit.tailBytes !== undefined) {
      const all = Buffer.concat(this.tailChunks)
      out.tail = all.subarray(Math.max(0, all.length - this.limit.tailBytes)).toString('utf8')
    }
    return out
  }
}

const SIGTERM_TO_SIGKILL_MS = 750

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * End a command and everything it started (ZCode `terminateGenericPosixProcessGroup`): the child
 * leads its own process group, so SIGTERM goes to the group, and SIGKILL follows after a grace
 * period while any member (a grandchild holding a pipe) is still alive. Windows has no process
 * groups: `taskkill /T /F` ends the tree.
 */
export function terminateProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill())
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  setTimeout(() => {
    if (!isProcessGroupAlive(pid)) return
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }, SIGTERM_TO_SIGKILL_MS).unref()
}

export function createNodeExecutionPort(env: NodeJS.ProcessEnv = process.env): ExecutionPort {
  return {
    run({ command, cwd, timeoutMs, outputLimit, signal }) {
      return new Promise<ExecutionResult>((resolve) => {
        const stdout = new StreamCollector(outputLimit)
        const stderr = new StreamCollector(outputLimit)
        let settled = false
        let timedOut = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let onAbort: (() => void) | undefined
        const finish = (result: Omit<ExecutionResult, 'stdout' | 'stderr'>): void => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
          resolve({ ...result, stdout: stdout.result(), stderr: stderr.result() })
        }
        let child: ReturnType<typeof spawn>
        try {
          // its own process group (POSIX), so cancel and timeout reach every process it starts
          child = spawn(command.file, command.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32', windowsHide: true })
        } catch (error) {
          finish({ status: 'spawn_error', error: { message: error instanceof Error ? error.message : String(error) } })
          return
        }
        onAbort = (): void => {
          terminateProcessTree(child)
          finish({ status: 'cancelled', error: { message: 'cancelled' } })
        }
        if (signal?.aborted === true) {
          onAbort()
          return
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        timer = timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
            timedOut = true
            terminateProcessTree(child)
          }, timeoutMs)
        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
        child.on('error', (error) => finish({ status: 'spawn_error', error: { message: error.message } }))
        child.on('close', (code, sig) => {
          if (timedOut) {
            finish({ status: 'timed_out', error: { message: `timed out after ${timeoutMs}ms` } })
            return
          }
          if (code === 0) finish({ status: 'completed', exitCode: 0 })
          else if (typeof code === 'number') finish({ status: 'failed', exitCode: code })
          else finish({ status: 'failed', error: { message: `terminated by signal ${String(sig)}` } })
        })
      })
    },
  }
}

// ————————————————————————————— file system —————————————————————————————

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.dsh', '.zcode', 'dist', 'lib', '.next', '.turbo', '.cache'])
/** The same exclusions for ripgrep, so a read returns the same set with or without rg installed. */
const RG_IGNORED = [...IGNORED_DIRS].flatMap(dir => ['--glob', `!${dir}`])

let ripgrep: string | null | undefined
function ripgrepPath(): string | null {
  if (ripgrep !== undefined) return ripgrep
  for (const candidate of [process.env.DSH_DWF_RG, 'rg'].filter((value): value is string => typeof value === 'string')) {
    try {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
      if (probe.status === 0) {
        ripgrep = candidate
        return ripgrep
      }
    } catch {
      // try the next candidate
    }
  }
  ripgrep = null
  return ripgrep
}

/** Translate a glob into a RegExp over workspace-relative, `/`-separated paths. */
export function globToRegExp(pattern: string): RegExp {
  let source = ''
  let i = 0
  const normalized = pattern.replace(/^\.\//, '')
  while (i < normalized.length) {
    const char = normalized[i]!
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        const slash = normalized[i + 2] === '/'
        source += slash ? '(?:.*/)?' : '.*'
        i += slash ? 3 : 2
        continue
      }
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '{') {
      const end = normalized.indexOf('}', i)
      if (end > i) {
        source += `(?:${normalized.slice(i + 1, end).split(',').map(escapeRegExp).join('|')})`
        i = end + 1
        continue
      }
      source += '\\{'
    } else if (char === '[') {
      const end = normalized.indexOf(']', i)
      if (end > i) {
        const inner = normalized.slice(i + 1, end)
        // glob `[!…]` negates the character class, which RegExp spells `[^…]`
        source += inner.startsWith('!') ? `[^${inner.slice(1)}]` : `[${inner}]`
        i = end + 1
        continue
      }
      source += '\\['
    } else {
      source += escapeRegExp(char)
    }
    i += 1
  }
  // A pattern without a slash matches the basename anywhere (gitignore / ripgrep semantics).
  return normalized.includes('/') ? new RegExp(`^${source}$`) : new RegExp(`(?:^|/)${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function* walk(root: string, dir: string = root): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue
      yield* walk(root, full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function toPosixRelative(root: string, path: string): string {
  const rel = isAbsolute(path) ? relative(root, path) : path
  return rel.split(sep).join('/')
}

function runCollect(file: string, args: string[], cwd: string, maxLines: number): Promise<{ lines: string[]; truncated: boolean; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const lines: string[] = []
    let pending = ''
    let truncated = false
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      pending += chunk.toString('utf8')
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) {
        if (lines.length >= maxLines) {
          truncated = true
          child.kill('SIGTERM')
          return
        }
        lines.push(line)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error) => resolve({ lines, truncated, code: -1, stderr: error.message }))
    child.on('close', (code) => {
      if (!truncated && pending.length > 0) {
        if (lines.length >= maxLines) truncated = true
        else lines.push(pending)
      }
      resolve({ lines, truncated, code, stderr })
    })
  })
}

export function createNodeFileSystemPort(): FileSystemPort {
  return {
    async searchFiles({ path, pattern, maxResults }) {
      const rg = ripgrepPath()
      if (rg !== null) {
        const out = await runCollect(rg, ['--files', '--hidden', ...RG_IGNORED, '--glob', pattern], path, maxResults)
        if (out.code === 0 || out.code === 1 || out.truncated) {
          return { files: out.lines.filter(line => line.length > 0).map(line => join(path, line)), truncated: out.truncated }
        }
      }
      const matcher = globToRegExp(pattern)
      const files: string[] = []
      for await (const file of walk(path)) {
        if (!matcher.test(toPosixRelative(path, file))) continue
        if (files.length >= maxResults) return { files, truncated: true }
        files.push(file)
      }
      return { files, truncated: false }
    },

    async readTextFile({ path }) {
      const info = await stat(path)
      if (!info.isFile()) throw new Error(`not a file: ${path}`)
      const MAX = 8 * 1024 * 1024
      if (info.size > MAX) throw new Error(`file is ${info.size} bytes, over the ${MAX}-byte read cap`)
      return { content: await readFile(path, 'utf8') }
    },

    async searchText({ path, pattern, glob, headLimit }) {
      const rg = ripgrepPath()
      if (rg !== null) {
        // --null ends the path with NUL: a file named `a:1:b.ts` cannot be mistaken for path + line
        const args = ['--line-number', '--no-heading', '--null', '--color', 'never', '--hidden', ...RG_IGNORED, ...glob === undefined ? [] : ['--glob', glob], '-e', pattern, '.']
        const out = await runCollect(rg, args, path, headLimit)
        if (out.code === 0 || out.code === 1 || out.truncated) {
          const entries = out.lines.filter(line => line.length > 0).flatMap((line) => {
            const nul = line.indexOf('\0')
            if (nul < 0) return []
            const match = /^(\d+):(.*)$/su.exec(line.slice(nul + 1))
            if (match === null) return []
            return [{ path: line.slice(0, nul).replace(/^\.\//, ''), lineNumber: Number(match[1]), text: match[2]! }]
          })
          return { entries, truncated: out.truncated }
        }
        throw new Error(`ripgrep failed: ${out.stderr.split('\n')[0] ?? ''}`)
      }
      const regex = new RegExp(pattern)
      const matcher = glob === undefined ? undefined : globToRegExp(glob)
      const entries: { path: string; lineNumber: number; text: string }[] = []
      for await (const file of walk(path)) {
        const rel = toPosixRelative(path, file)
        if (matcher !== undefined && !matcher.test(rel)) continue
        let content: string
        try {
          const info = await stat(file)
          if (info.size > 4 * 1024 * 1024) continue
          content = await readFile(file, 'utf8')
        } catch {
          continue
        }
        if (content.includes('\u0000')) continue
        const lines = content.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          if (!regex.test(lines[index]!)) continue
          if (entries.length >= headLimit) return { entries, truncated: true }
          entries.push({ path: rel, lineNumber: index + 1, text: lines[index]! })
        }
      }
      return { entries, truncated: false }
    },
  }
}
