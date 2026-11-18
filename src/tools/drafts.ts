/**
 * Script drafts as files the model already knows (ZCode `workflow-draft-read-state.ts` and
 * `permission/workflow-draft-path.ts`).
 *
 * 1. **An inline draft counts as read.** DSH's base bundle composes `fs-observation-policy`:
 *    `edit` refuses a file the session has not read (`FS_NOT_OBSERVED`). The draft's bytes are
 *    exactly the `script` argument of the call that produced it, so the plugin records a present
 *    observation for the owner session. Without it the first edit after a compile diagnostic
 *    fails, and the remedy is re-reading a twenty-thousand-token script the model just wrote.
 *    Best effort, as in ZCode: no fs service or no stat means no record, and the model falls
 *    back to reading first.
 * 2. **Draft edits never prompt.** Under a session policy that asks before writing (read-only
 *    sandbox), an approval request for a file tool whose target lies in the drafts directory is
 *    answered `allowed-once`. The decision is a pure path judgement (no realpath, no stat): the
 *    same input gives the same answer on any machine, and a failed disk read can never turn
 *    "do not allow" into "allow".
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isDraftPath } from './sources.ts'

/** File tools whose single target path decides a draft exemption. */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'str_replace_editor', 'str_replace_based_edit_tool'])
const PATH_KEYS = ['file_path', 'filePath', 'path', 'target_file', 'targetFile', 'file']

interface FsLike {
  resolve(path: string, options?: { cwd?: string }): Promise<unknown>
  stat(target: unknown): Promise<{ version?: unknown } | undefined>
}

/** Record the draft at `path` as observed (present, current version) by `agent`'s session. */
export async function recordAuthoredDraft(ctx: Context, agent: Agent, path: string): Promise<boolean> {
  const fs = (ctx as unknown as { get(name: string): unknown }).get('fs') as FsLike | undefined
  if (fs === undefined) return false
  try {
    const cwd = agent.session.header.cwd
    const target = await fs.resolve(path, cwd === undefined ? {} : { cwd })
    const info = await fs.stat(target)
    if (info?.version === undefined) return false
    ;(ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit('fs/observed', target, { kind: 'present', version: info.version }, { agent })
    return true
  } catch {
    return false
  }
}

/** The target path of a file tool call, from its arguments. */
export function fileToolTarget(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  for (const key of PATH_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

interface ApprovalRequestLike {
  agent: Agent
  toolName: string
  callId?: string
}

/** The arguments of the tool call `callId` in `agent`'s session, or undefined. */
function callArguments(agent: Agent, callId: string): unknown {
  const events = (agent.session as unknown as { snapshotEvents(): readonly { type: string; data: unknown }[] }).snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    if (event.type !== 'tool/call') continue
    const data = event.data as { callId?: string; arguments?: string }
    if (data.callId !== callId) continue
    try {
      return JSON.parse(data.arguments ?? '{}') as unknown
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Whether an approval request is a file write into the session's drafts directory. */
export function isDraftWriteRequest(req: ApprovalRequestLike): boolean {
  if (!FILE_WRITE_TOOLS.has(req.toolName) || req.callId === undefined) return false
  const cwd = req.agent.session.header.cwd
  if (cwd === undefined || cwd === '') return false
  const target = fileToolTarget(callArguments(req.agent, req.callId))
  return target !== undefined && isDraftPath(cwd, target)
}

/** Answer approval requests for draft writes before any interactive answerer sees them. */
export function installDraftWriteExemption(ctx: Context): void {
  ctx.on('approval/request' as never, ((req: ApprovalRequestLike, next: () => Promise<string>) => {
    try {
      if (isDraftWriteRequest(req)) return Promise.resolve('allowed-once')
    } catch {
      // a malformed log never grants: fall through to the normal answerers
    }
    return next()
  }) as never, { prepend: true } as never)
}
