/**
 * Workflow notices in Chat. The Host half delivers `<task-notification>` / escalation / hole
 * texts to the main agent as user messages with `source: { kind: 'dynamic-workflow', ... }`.
 * Chat would show them as a generic "Context injection" row; this Definition claims them
 * (exclusive, Chat target only — the trajectory view still sees the raw message) and renders a
 * compact chip: status dot + one-line summary, expandable to the full model-facing text.
 */

import { DisclosureRow, IconLayersOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationNodeDefinition, SessionEventLike, Translate, UseDisclosureResult } from './host-types.ts'

export interface NoticeData {
  /** `notice`: a run notice to the main agent; `relay`: the task a workflow gave a subagent. */
  form: 'notice' | 'relay'
  summary: string
  text: string
  time: number
  tone: 'done' | 'error' | 'warning' | 'info'
}

interface NoticeState extends NoticeData { seq: number }

interface UserMessageData {
  id: string | number
  content: readonly { type: string; text?: string }[]
  source?: { kind?: unknown; form?: unknown; summary?: unknown }
}

function sourceOf(event: SessionEventLike): UserMessageData['source'] | undefined {
  if (event.type !== 'user/message' || event.surfaceOp !== 'append') return undefined
  const source = (event.data as UserMessageData).source
  return source !== undefined && source !== null && typeof source === 'object' && source.kind === 'dynamic-workflow' ? source : undefined
}

/** The notices are XML-escaped for the model; show the user the plain text. */
export function unescapeXml(text: string): string {
  return text.replace(/&(quot|apos|lt|gt|amp);/gu, (_, name: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name] ?? _)
}

function toneOf(text: string): NoticeData['tone'] {
  const status = /<status>([a-z_]+)<\/status>/u.exec(text)?.[1]
  if (status === 'completed') return 'done'
  if (status === 'failed' || status === 'errored') return 'error'
  if (status === 'stopped' || status === 'killed') return 'warning'
  if (text.includes('<workflow-escalation') || text.includes('<workflow-hole') || text.includes('<workflow-blocked')) return 'warning'
  return 'info'
}

export const noticeDefinition: ConversationNodeDefinition<NoticeState> = {
  kind: 'dynamic-workflow-notice',
  target: 'chat',
  match: (event) => {
    if (sourceOf(event) === undefined) return null
    return { id: String((event.data as UserMessageData).id), role: 'start', exclusive: true }
  },
  start: (_context, match) => {
    const data = match.event.data as UserMessageData
    const text = data.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')
    const form = data.source?.form === 'relay' ? 'relay' as const : 'notice' as const
    const firstLine = text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
    const summary = typeof data.source?.summary === 'string' && data.source.summary !== '' ? data.source.summary : firstLine.slice(0, 160)
    return { seq: match.event.seq, time: match.event.time, form, summary, text, tone: form === 'relay' ? 'info' : toneOf(text) }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const { seq, ...data } = context.state
    const location = (context.start?.location ?? { kind: 'unresolved' }) as { kind: string; step?: { step?: number } }
    return {
      key: context.key,
      kind: 'dynamic-workflow-notice',
      id: context.id,
      target: 'chat',
      anchorSeq: seq,
      location,
      groupTree: location.kind === 'step' && location.step?.step === 1 ? 'exchange' : 'input',
      visibility: 'visible',
      data,
    }
  },
}

/** The reader's-language one-liner of a terminal notification (the stored summary is model-facing English). */
export function localizedSummary(data: NoticeData, t: Translate): string {
  if (data.form !== 'notice' || !data.text.startsWith('<task-notification>')) return data.summary
  const status = /<status>([a-z_]+)<\/status>/u.exec(data.text)?.[1]
  const name = unescapeXml(/<description>([\s\S]*?)<\/description>/u.exec(data.text)?.[1] ?? '')
  return status === 'completed' || status === 'errored' || status === 'stopped'
    ? t(`notice.run.${status}`, { name })
    : data.summary
}

export function NoticeChip({ node, t, useDisclosure }: { node: { data: NoticeData }; t: Translate; useDisclosure: () => UseDisclosureResult }) {
  const { expanded, toggle } = useDisclosure()
  const { data } = node
  return (
    <div className="dwf-notice" data-tone={data.tone} data-form={data.form}>
      <DisclosureRow
        icon={<span className="dwf-notice-icon"><IconLayersOutlineRegular size={14} /></span>}
        title={t(data.form === 'relay' ? 'notice.task' : 'notice.title')}
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={toggle}
        collapsedContent={<span className="dwf-notice-summary"><span className="dwf-notice-dot" data-tone={data.tone} aria-hidden />{localizedSummary(data, t)}</span>}
      >
        <pre className="dwf-code dwf-notice-text">{unescapeXml(data.text)}</pre>
      </DisclosureRow>
    </div>
  )
}
