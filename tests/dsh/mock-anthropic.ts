/**
 * A local Anthropic Messages endpoint (`POST /v1/messages`, SSE streaming) driven by a routing
 * function — the stand-in for the user's gateway when the real one is unreachable. It speaks the
 * wire protocol pi-ai's `anthropic-messages` client expects (message_start → content blocks with
 * text_delta / input_json_delta → message_delta with usage → message_stop), records every request
 * as received, and can answer with an HTTP error (429 with Retry-After, 5xx, quota bodies).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type MockReply =
  | { kind: 'text'; text: string; usage?: { input: number; output: number } }
  | { kind: 'tool'; name: string; input: unknown; text?: string; usage?: { input: number; output: number } }
  | { kind: 'http'; status: number; body: unknown; headers?: Record<string, string> }

export interface AnthropicRequestView {
  model: string
  system: string
  tools: { name: string; description?: string; input_schema: Record<string, unknown> }[]
  messages: { role: 'user' | 'assistant'; content: string | Record<string, unknown>[] }[]
  /** Text of the last user text block that is not a DSH runtime-context reminder. */
  lastUser: string
  /** The tool result the newest user message carries, with the name of the call it answers. */
  lastToolResult?: { name: string; text: string; isError: boolean }
  headers: IncomingMessage['headers']
  stream: boolean
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(block => (block as { type?: string; text?: string }).type === 'text' ? (block as { text: string }).text : '').join('')
}

export function viewOf(body: Record<string, unknown>, headers: IncomingMessage['headers']): AnthropicRequestView {
  const messages = (body.messages ?? []) as AnthropicRequestView['messages']
  const system = typeof body.system === 'string' ? body.system : textOf(body.system)
  const names = new Map<string, string>()
  let lastUser = ''
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === 'tool_use') names.set(String(block.id), String(block.name))
    }
    if (message.role === 'user') {
      const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content
      for (const block of blocks) {
        const text = block.type === 'text' ? String(block.text) : ''
        if (text !== '' && !text.startsWith('<system-reminder>')) lastUser = text
      }
    }
  }
  // The trailing user turn may span several user messages: DSH appends its runtime-context
  // reminder after tool results, and a client may or may not merge them into one message.
  let lastToolResult: AnthropicRequestView['lastToolResult']
  for (let i = messages.length - 1; i >= 0 && messages[i]!.role === 'user' && lastToolResult === undefined; i -= 1) {
    const content = messages[i]!.content
    if (!Array.isArray(content)) continue
    const result = [...content].reverse().find(block => block.type === 'tool_result')
    if (result !== undefined) {
      lastToolResult = { name: names.get(String(result.tool_use_id)) ?? '?', text: textOf(result.content), isError: result.is_error === true }
    }
  }
  return {
    model: String(body.model),
    system,
    tools: (body.tools ?? []) as AnthropicRequestView['tools'],
    messages,
    lastUser,
    ...lastToolResult === undefined ? {} : { lastToolResult },
    headers,
    stream: body.stream === true,
  }
}

function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

let sequence = 0

function streamReply(res: ServerResponse, model: string, reply: Exclude<MockReply, { kind: 'http' }>): void {
  const id = `msg_mock_${++sequence}`
  const usage = reply.usage ?? { input: 120, output: 30 }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  sse(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } } })
  let index = 0
  const text = reply.kind === 'text' ? reply.text : reply.text
  if (text !== undefined && text !== '') {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
    // stream in a few chunks, as a real model would
    for (const chunk of text.match(/[\s\S]{1,24}/gu) ?? []) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
    index += 1
  }
  if (reply.kind === 'tool') {
    sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_mock_${sequence}`, name: reply.name, input: {} } })
    const json = JSON.stringify(reply.input)
    for (const chunk of json.match(/[\s\S]{1,40}/gu) ?? []) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: chunk } })
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  }
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

export interface MockAnthropic {
  url: string
  requests: AnthropicRequestView[]
  errors: { status: number; at: number }[]
  close(): Promise<void>
}

export async function startMockAnthropic(route: (request: AnthropicRequestView) => MockReply | Promise<MockReply>): Promise<MockAnthropic> {
  const requests: AnthropicRequestView[] = []
  const errors: MockAnthropic['errors'] = []
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${req.method} ${req.url}` } }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const view = viewOf(body, req.headers)
      requests.push(view)
      const reply = await route(view)
      if (reply.kind === 'http') {
        errors.push({ status: reply.status, at: Date.now() })
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
        res.end(JSON.stringify(reply.body))
        return
      }
      if (!view.stream) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'mock serves streaming requests only' } }))
        return
      }
      streamReply(res, view.model, reply)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(error) } }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    errors,
    close: () => new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
