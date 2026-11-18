/** Resolve the Agent of a session: live, or loaded through the Host's session controller. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

export async function resolveOwnerAgent(ctx: Context, sessionId: string): Promise<Agent | undefined> {
  const live = ctx.agents.get(sessionId as SessionId)
  if (live !== undefined) return live
  const controller = ctx.get('sessionController') as { resolveAgent?: (id: SessionId) => Promise<{ agent: Agent } | { error: unknown }> } | undefined
  if (controller?.resolveAgent === undefined) return undefined
  try {
    const resolved = await controller.resolveAgent(sessionId as SessionId)
    return 'agent' in resolved ? resolved.agent : undefined
  } catch {
    return undefined
  }
}
