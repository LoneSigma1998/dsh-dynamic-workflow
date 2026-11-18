/**
 * Identified, frozen user-role messages without a runtime dependency on
 * `@deepseek-ai/dsh-llm` (same shape as its `createUserMessage`): the plugin
 * bundle then carries no runtime import of any host package, so it loads in
 * any DSH profile whatever the install layout.
 */

import { randomUUID } from 'node:crypto'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

export type WorkflowMessageSource =
  | { kind: 'user' }
  | { kind: 'dynamic-workflow'; form: 'relay' }
  | { kind: 'dynamic-workflow'; form: 'notice'; summary: string }

export function userMessage(text: string, source: WorkflowMessageSource, id: string = randomUUID()): UserMessage {
  return deepFreeze(structuredClone({ id, role: 'user', content: [{ type: 'text', text }], source })) as unknown as UserMessage
}
