/**
 * `eval_workflow_snippet`: a scratch bench for world reads — the same compiler,
 * sandbox and world-read path as a real run, under the snippet facade (no
 * agent(), report(), artifact or phase), journaled in memory and discarded.
 * Ported from ZCode `bootstrap/src/app/dynamic-workflow-snippet-service.ts` (Apache-2.0).
 */

import { randomUUID } from 'node:crypto'
import {
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  InMemoryJournalStore,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  validate,
  WorkflowError,
  type AskSpec,
  type JsonSchema,
  type RunEvent,
  type WorkflowDriver,
} from '@zcode/dynamic-workflow'
import { runWorkflowScript } from '@zcode/dynamic-workflow-runtime'
import { executeWorldRead } from '../world/world-read.ts'
import { createNodeExecutionPort, createNodeFileSystemPort } from '../world/ports.ts'

const MAX_LOGS = 100
const MAX_LOG_CHARS = 2048
const MAX_RESULT_BYTES = 256 * 1024

export interface PreparedSnippet {
  lowered: string
  askSpecs: Map<string, AskSpec>
  /** Literal `world.run` commands declared by this snippet (non-empty ⇒ requires confirmation). */
  worldRunCommands: readonly string[]
}

export type SnippetInspectResult =
  | { ok: true; prepared: PreparedSnippet }
  | { ok: false; text: string }

/** Compile a snippet against the scratch facade once and collect any literal `world.run` commands. */
export function inspectSnippet(code: string): SnippetInspectResult {
  const workflow = createWorkflowProgram(code, { facadeDts: SNIPPET_FACADE_DTS })
  const diagnostics = collectDiagnostics(workflow.program)
  if (diagnostics.length > 0) {
    return { ok: false, text: `Diagnostics:\n${diagnostics.map(d => `L${d.line}:C${d.column} ${d.message}`).join('\n')}` }
  }
  const table = collectSites(workflow)
  const worldRun = collectWorldRunCommands(workflow, table)
  if (worldRun.diagnostics.length > 0) {
    return { ok: false, text: `Diagnostics:\n${worldRun.diagnostics.map(d => `L${d.line}:C${d.column} ${d.message}`).join('\n')}` }
  }
  const lowered = lowerWorkflow(workflow, table)
  return {
    ok: true,
    prepared: {
      lowered: lowered.code,
      askSpecs: buildAskSpecs(table, {}),
      worldRunCommands: worldRun.commands,
    },
  }
}

export interface SnippetRunner {
  inspect(code: string): SnippetInspectResult
  run(code: string, cwd: string, timeoutMs: number, signal?: AbortSignal, prepared?: PreparedSnippet): Promise<{ ok: boolean; text: string }>
}

export function createSnippetRunner(): SnippetRunner {
  const fileSystemPort = createNodeFileSystemPort()
  const executionPort = createNodeExecutionPort()
  return {
    inspect: inspectSnippet,
    async run(code, cwd, timeoutMs, signal, prepared) {
      let ready = prepared
      if (ready === undefined) {
        const inspected = inspectSnippet(code)
        if (!inspected.ok) return inspected
        ready = inspected.prepared
      }
      const logs: string[] = []
      let logsTruncated = false
      const capture = (event: RunEvent): void => {
        if (event.type !== 'log') return
        if (logs.length >= MAX_LOGS) {
          logsTruncated = true
          return
        }
        logs.push(event.message.slice(0, MAX_LOG_CHARS))
      }
      // Combine caller cancel and wall-clock timeout into one signal so `world.run` / `git.*`
      // child process trees are killed immediately when the snippet is aborted or times out.
      const combined = new AbortController()
      const onCallerAbort = (): void => { combined.abort(signal?.reason ?? new Error('aborted')) }
      if (signal?.aborted === true) onCallerAbort()
      else signal?.addEventListener('abort', onCallerAbort, { once: true })
      const timer = setTimeout(() => { combined.abort(new Error(`snippet timed out after ${timeoutMs}ms`)) }, timeoutMs)
      timer.unref?.()
      const unreachable = (member: string): WorkflowError => new WorkflowError('DriverError', `Snippet driver received ${member}; the scratch facade has no agent().`)
      const driver: WorkflowDriver = {
        createActorSession: () => Promise.reject(unreachable('createActorSession')),
        startAsk: () => { throw unreachable('startAsk') },
        respondToSubmit: () => { throw unreachable('respondToSubmit') },
        cancelAsk: () => undefined,
        executeWorldRead: (op, args) => executeWorldRead({ fileSystemPort, executionPort, cwd, signal: combined.signal }, op, args),
        journal: new InMemoryJournalStore(),
        emit: capture,
      }
      let settlement
      try {
        settlement = await runWorkflowScript({
          askSpecs: ready.askSpecs,
          caps: { maxConcurrency: 4 },
          cwd,
          lowered: ready.lowered,
          makeDriver: () => driver,
          runId: `dwfeval-${randomUUID()}`,
          signal: combined.signal,
          timeoutMs,
          validate: (schema, value) => validate(schema as JsonSchema, value),
        })
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onCallerAbort)
      }
      const logText = logs.length === 0 ? '' : `\nLogs${logsTruncated ? ' (truncated)' : ''}:\n${logs.map(line => `  ${line}`).join('\n')}`
      if (settlement.status === 'completed') {
        const artifact = (settlement as { artifact?: unknown }).artifact
        const rendered = artifact === undefined ? 'undefined' : JSON.stringify(artifact, null, 2)
        if (Buffer.byteLength(rendered, 'utf8') > MAX_RESULT_BYTES) {
          return { ok: false, text: `The snippet's return value is over ${MAX_RESULT_BYTES} bytes; return a summary instead.${logText}` }
        }
        return { ok: true, text: `Completed. Return value:\n${rendered}${logText}` }
      }
      const error = (settlement as { error?: { code?: string; message?: string } }).error
      return { ok: false, text: `${settlement.status}: ${error?.code ?? ''} ${error?.message ?? ''}${logText}` }
    },
  }
}
