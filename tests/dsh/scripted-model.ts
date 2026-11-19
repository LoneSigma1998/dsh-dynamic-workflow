/**
 * A scripted LLM adapter for integration tests: every agent of the
 * composition (the main agent and the workflow's child agents) talks to it,
 * and a `respond` function decides each answer from the request it receives —
 * so the test plays "the model" for the whole run without a network.
 */

import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'

export function text(answer: string, usage = { inputTokens: 100, outputTokens: 20 }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: answer },
    { type: 'block-end', index: 0, block: { type: 'text', text: answer } },
    { type: 'usage', usage },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

let callSeq = 0
export function toolCall(name: string, args: object): StreamChunk[] {
  const id = `call_${++callSeq}` as ToolCallId
  const json = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: json },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: json } },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 30 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export interface RequestView {
  /** Tool names declared on this request. */
  tools: string[]
  /** Text of the last user-role message. */
  lastUser: string
  /** Name of the tool whose result is the last message, if any. */
  lastToolResult?: { name: string; text: string; isError: boolean }
  /** The request's abort signal (a handler that waits should honour it). */
  signal?: AbortSignal
  /** Resolved provider & model on this request. */
  provider: string
  model: string
  reasoningEffort?: string
  /** Whole system prompt text. */
  system: string
  messages: GenerateOptions['messages']
}

export function view(options: GenerateOptions): RequestView {
  const messages = options.messages
  const textOf = (content: unknown): string => Array.isArray(content)
    ? content.map(block => (block as { type: string; text?: string }).type === 'text' ? (block as { text: string }).text : '').join('')
    : ''
  let lastUser = ''
  let system = ''
  const callNames = new Map<string, string>()
  for (const message of messages) {
    if (message.role === 'system') system += textOf(message.content)
    // DSH runtime-context messages (systemPrompt.context snapshots) ride after the claimed input;
    // route on the last real input instead.
    if (message.role === 'user' && (message as { source?: { kind?: string } }).source?.kind !== 'runtime-context') lastUser = textOf(message.content)
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if ((block as { type: string }).type === 'tool-call') callNames.set((block as { id: string }).id, (block as { name: string }).name)
      }
    }
  }
  const isContext = (message: (typeof messages)[number]): boolean => (message as { source?: { kind?: string } }).source?.kind === 'runtime-context'
  const last = messages.filter(message => !isContext(message)).at(-1)
  const lastToolResult = last?.role === 'tool'
    ? { name: callNames.get((last as { toolCallId: string }).toolCallId) ?? '?', text: textOf(last.content), isError: (last as { isError?: boolean }).isError === true }
    : undefined
  return {
    tools: (options.tools ?? []).map(tool => tool.name),
    lastUser,
    ...lastToolResult === undefined ? {} : { lastToolResult },
    provider: options.provider,
    model: options.model,
    ...(options as { reasoningEffort?: string }).reasoningEffort === undefined ? {} : { reasoningEffort: (options as { reasoningEffort?: string }).reasoningEffort },
    system,
    messages,
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
}

export class ScriptedModel extends LlmAdapter {
  readonly requests: RequestView[] = []

  constructor(private readonly respond: (request: RequestView) => StreamChunk[] | Promise<StreamChunk[]>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      contextWindow: 200_000,
      reasoning: {
        efforts: [
          { id: 'low' as never, name: 'Low' },
          { id: 'medium' as never, name: 'Medium' },
          { id: 'high' as never, name: 'High' },
        ],
      },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const request = view(options)
    this.requests.push(request)
    const chunks = await this.respond(request)
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
