/**
 * Visual preview of the plugin's Web surfaces with real data (fixtures from make-fixtures.ts)
 * and the real DSH primitives + theme tokens. Not a DSH page: the slot machinery is replaced by
 * hand-built props matching the structural contracts in src/client/host-types.ts.
 */

import '../../src/client/styles.css'
import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfirmCard } from '../../src/client/ConfirmCard.tsx'
import type { PartialArguments, PendingQuestionLike, ToolCallViewProps, Translate } from '../../src/client/host-types.ts'
import { en, zh } from '../../src/client/locales.ts'
import { NoticeChip, noticeDefinition, type NoticeData } from '../../src/client/notice.tsx'
import { RunNode } from '../../src/client/RunNode.tsx'
import { RunPane } from '../../src/client/RunPane.tsx'
import { WorkflowToolCard } from '../../src/client/WorkflowToolCard.tsx'
import { applyProgressEvent } from '../../src/web/projection.ts'
import { ICON_SYMBOLS } from '@dsh-primitives/icons/artwork.ts'

// The shell's document icon sprite (ui-theme installIconSprite), rebuilt from the same artwork.
const sprite = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
sprite.setAttribute('style', 'display:none')
sprite.innerHTML = Object.entries(ICON_SYMBOLS).map(([id, svg]) => {
  const viewBox = /viewBox="([^"]+)"/u.exec(svg)?.[1] ?? '0 0 16 16'
  return `<symbol id="${id}" viewBox="${viewBox}">${svg.replace(/^<svg[^>]*>/u, '').replace(/<\/svg>$/u, '')}</symbol>`
}).join('')
document.body.prepend(sprite)
import type { WorkflowRunsState } from '../../src/shared/runs/workflow-runs.ts'

declare const FIXTURES: {
  graphs: { title: string; script: string; display: { causalityGraph: unknown; name: string } }[]
  diagnostics: unknown
  run: { display: { runId: string; name: string; causalityGraph: unknown }; call: { callId: string; arguments: string }; progress: unknown[]; notices: { id: string; content: { type: string; text: string }[]; source: unknown }[] }
}
declare const LOCALE: 'en' | 'zh'
declare const ONLY: string

const dict = LOCALE === 'zh' ? zh : en
const t: Translate = (key, params) => {
  const template = (dict as Record<string, string>)[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? `{${name}}`))
}

function args(values: Record<string, string>, sealed = true): PartialArguments {
  return {
    isSealed: sealed,
    closed: () => sealed,
    has: key => key in values,
    complete: key => sealed || key !== Object.keys(values).at(-1),
    text: key => values[key],
    textPrefix: (key, max) => values[key]?.slice(0, max),
    value: key => values[key],
  }
}

function reduce(progress: unknown[], count = progress.length): WorkflowRunsState {
  let state: WorkflowRunsState = { revision: 0, runs: [] }
  for (const data of progress.slice(0, count)) state = applyProgressEvent(state, { type: 'plugin:dynamic-workflow/progress', data })
  return state
}

const SESSION = 'session-preview'
const live = FIXTURES.run
const liveArgs = JSON.parse(live.call.arguments) as { name: string; script: string }
const rich = FIXTURES.graphs[0]!
const fan = FIXTURES.graphs.find(g => g.title.includes('Flaky')) ?? FIXTURES.graphs[1]!

// The fetches the client makes to the Host half, answered from fixtures.
const originalFetch = window.fetch.bind(window)
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/pending-launch')) {
    return Response.json({ pending: { tool: 'create_workflow', name: fan.title, scriptText: fan.script, display: fan.display, settings: { maxConcurrency: 8, subagentModel: 'deepseek/deepseek-v4-flash' }, askedAt: Date.now() } })
  }
  if (url.includes('/nodes')) return Response.json({ nodes: [] })
  if (url.includes('/changes')) return Response.json({ changes: [] })
  if (url.includes('/save-probe')) return Response.json({ taken: false, shadowing: false })
  if (url.includes(`runs/${encodeURIComponent(live.display.runId)}`)) {
    return Response.json({ snapshot: { name: live.display.name, status: 'completed', spentTokens: 23_695_436, logTail: [], artifacts: [{ id: 'summary', kind: 'markdown', title: 'Review summary', primary: true, version: 1 }] }, script: liveArgs.script, graph: live.display.causalityGraph, durationMs: 312_000, savedAs: null, canSave: true })
  }
  return originalFetch(input, init)
}) as typeof fetch

function useDisclosure(initial = false) {
  const [expanded, setExpanded] = useState(initial)
  return useMemo(() => ({ expanded, setExpanded, toggle: () => setExpanded(v => !v) }), [expanded])
}

function Card({ props }: { props: Omit<ToolCallViewProps, 'useDisclosure' | 't' | 'sessionId'> & { state?: WorkflowRunsState; open?: boolean } }) {
  const disclosure = useDisclosure(props.open ?? false)
  const state = props.state
  const all = {
    ...props,
    t,
    sessionId: SESSION,
    useDisclosure: () => disclosure,
    useProjection: ((_key: string, selector?: (v: WorkflowRunsState | undefined) => unknown) => (selector === undefined ? state : selector(state))) as ToolCallViewProps['useProjection'],
    openChild: (id: string) => console.log('openChild', id),
    openRun: (id: string) => console.log('openRun', id),
  } as unknown as Parameters<typeof WorkflowToolCard>[0]
  return <WorkflowToolCard {...all} />
}

function Section({ title, children, width = 760 }: { title: string; children: React.ReactNode; width?: number }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 className="pv-h">{title}</h2>
      <div style={{ width: '100%', maxWidth: width }}>{children}</div>
    </section>
  )
}

const stable = { channel: 'waterfall' as const, closed: false }
const pending: PendingQuestionLike = {
  kind: 'question',
  key: 'q-1',
  sessionId: SESSION,
  questions: [{ id: 'dynamic-workflow-confirm', header: 'Run workflow', question: `Run the workflow "${fan.title}"?`, detail: 'fallback detail' }],
  snapshot: () => stable,
  getSnapshot: () => stable,
  subscribe: () => () => undefined,
  answer: async answer => { console.log('answer', JSON.stringify(answer)) },
  dismiss: async () => undefined,
}

function noticeOf(index: number): NoticeData {
  const message = live.notices[index]!
  const state = noticeDefinition.start({ key: 'k', kind: 'dynamic-workflow-notice', id: 'n', start: undefined, state: undefined }, { event: { type: 'user/message', seq: 1, time: Date.now(), data: message, surfaceOp: 'append' }, role: 'start', location: { kind: 'unresolved' } })
  const { seq: _seq, ...data } = state as NoticeData & { seq: number }
  return data
}

function App() {
  const scenario = ONLY === '' ? null : ONLY
  const midCount = Math.max(1, live.progress.findIndex((p, i) => i > 18 && (p as { eventType: string }).eventType === 'node-dispatched') + 1)
  const mid = reduce(live.progress, midCount)
  const done = reduce(live.progress)
  const partial = rich.script.slice(0, Math.floor(rich.script.length * 0.62))
  const NoticeDisclosure = () => {
    const d = useDisclosure(true)
    return <NoticeChip node={{ data: noticeOf(0) }} t={t} useDisclosure={() => d} />
  }
  const all = [
    ['1 · Writing the script (streaming draft)', <Card key="a" props={{ phase: 'preparing', callId: 'c-draft', toolName: 'create_workflow', block: { phase: 'preparing', callId: 'c-draft', name: 'create_workflow', turn: 1, step: 1, time: 0, args: args({ name: rich.title, script: partial }, false) } } as never} />],
    ['2 · Confirmation in the composer seat', <ConfirmCard key="b" matched={{ pending, item: pending.questions[0]! }} t={t} />],
    ['3 · Live run (mid-run, from the real progress records)', <Card key="c" props={{ phase: 'result', callId: live.call.callId, toolName: 'create_workflow', state: mid, block: { kind: 'tool-result', seq: 9, time: 0, callId: live.call.callId, name: 'create_workflow', args: args({}), call: { name: 'create_workflow', argsRaw: live.call.arguments }, content: [{ type: 'text', text: 'launched' }], isError: false, meta: live.display } } as never} />],
    ['4 · Completed run (turn-level RunNode)', <RunNode key="d" node={{ data: { runId: live.display.runId, toolCallId: live.call.callId } }} t={t} sessionId={SESSION} useProjection={((_k: string, sel?: (v: WorkflowRunsState) => unknown) => (sel === undefined ? done : sel(done))) as never} openChild={id => console.log('openChild', id)} openRun={id => console.log('openRun', id)} />],
    ['5 · Rich graph (loop with back edge), static', <Card key="e" props={{ phase: 'result', callId: 'c-rich', toolName: 'create_workflow', block: { kind: 'tool-result', seq: 9, time: 0, callId: 'c-rich', name: 'create_workflow', args: args({}), call: { name: 'create_workflow', argsRaw: JSON.stringify({ name: rich.title, script: rich.script }) }, content: [], isError: false, meta: { ...rich.display, runId: undefined } } } as never} />],
    ['6 · Typecheck failure', <Card key="f" props={{ phase: 'result', callId: 'c-bad', toolName: 'create_workflow', block: { kind: 'tool-result', seq: 9, time: 0, callId: 'c-bad', name: 'create_workflow', args: args({}), call: { name: 'create_workflow', argsRaw: JSON.stringify({ name: 'broken-script', script: 'const x: number = "nope"' }) }, content: [], isError: true, meta: FIXTURES.diagnostics } } as never} />],
    ['7 · Notice chip (terminal notification, expanded)', <NoticeDisclosure key="g" />],
    ['8 · Run pane (right sidebar)', <div key="h" style={{ height: 620, border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 12 }}><RunPane t={t} sessionId={SESSION} useProjection={((_k: string, sel?: (v: WorkflowRunsState) => unknown) => (sel === undefined ? done : sel(done))) as never} useTabInfo={() => ({ tab: { navigation: { params: { sessionId: SESSION, runId: live.display.runId }, revision: 1 } } })} openChild={id => console.log('openChild', id)} /></div>],
  ] as const
  return (
    <main className="pv-main">
      {all.filter((_, i) => scenario === null || scenario.split(',').includes(String(i + 1))).map(([title, node]) => (
        <Section key={title} title={title} width={title.startsWith('8') ? 420 : 760}>{node}</Section>
      ))}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
