/**
 * The skill gate (ZCode's HTTP-428-style refusal): authoring tools refuse until
 * the `dynamic-workflows` skill is loaded in the history the model can still
 * see. Reading the *visible* history (DSH's `deriveMessages()`) rather than a
 * session flag is deliberate: once compaction pushes the skill text out, the
 * model has forgotten the facade, and the gate closes again.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

export const WORKFLOW_SKILL_NAME = 'dynamic-workflows'
export const WORKFLOW_SKILL_NOT_LOADED_CODE = 428

interface MessageLike {
  role: string
  content?: readonly { type: string; id?: string; name?: string; arguments?: string }[]
  toolCallId?: string
  isError?: boolean
}

export function sessionHasLoadedSkill(agent: Agent, skillName: string = WORKFLOW_SKILL_NAME): boolean {
  let messages: readonly MessageLike[]
  try {
    messages = (agent.session as unknown as { deriveMessages(): MessageLike[] }).deriveMessages()
  } catch {
    return true // no readable history: do not block
  }
  const calls = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content ?? []) {
        if (block.type !== 'tool-call' || block.name !== 'skill' || block.id === undefined) continue
        try {
          const args = JSON.parse(block.arguments ?? '{}') as { name?: unknown; skill?: unknown }
          if (args.name === skillName || args.skill === skillName) calls.add(block.id)
        } catch {
          // unparsable arguments are not a skill load
        }
      }
    } else if (message.role === 'tool' && message.toolCallId !== undefined && calls.has(message.toolCallId) && message.isError !== true) {
      return true
    } else if (message.role === 'user') {
      // `/dynamic-workflows` expansion or our own `/workflow` command inlines the skill text.
      for (const block of message.content ?? []) {
        const text = (block as { text?: unknown }).text
        if (typeof text === 'string' && (text.includes(`<skill_content name="${skillName}">`) || text.includes(`<skill name="${skillName}">`))) return true
      }
    }
  }
  return false
}

export function skillGateMessage(toolName: string): string {
  return `${toolName} needs the \`${WORKFLOW_SKILL_NAME}\` skill loaded (error ${WORKFLOW_SKILL_NOT_LOADED_CODE}). `
    + `Call the skill tool with name "${WORKFLOW_SKILL_NAME}" first — it carries the facade, the compile rules and the patterns — `
    + `then call ${toolName} again. Nothing was started.`
}
