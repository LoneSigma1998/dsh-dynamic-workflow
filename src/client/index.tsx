/**
 * Web client half of dsh-dynamic-workflow (bundled to lib/client.js and loaded by the Web shell
 * from the same Loader entry as the Host half).
 *
 *   - `tool.call.toolview` for create_workflow / amend_workflow / fill_workflow_hole: the
 *     timeline card (draft while streaming, live run after launch);
 *   - `conversation.composer` (priority −1) for the `dynamic-workflow-confirm` question: the
 *     confirmation card with the phase graph;
 *   - a turn-level Chat node per run (RunNode.tsx) with the live timeline, which stays visible
 *     after DSH folds the turn's tool calls;
 *   - a Conversation Definition + `conversation.chat.node` renderer that turns the run notices
 *     delivered to the main agent into compact chips;
 *   - a right-sidebar page tab with the full run pane.
 *
 * Runtime imports are limited to the shell's platform modules (react, primitives); every DSH
 * client contract is structural (`host-types.ts`).
 */

import './styles.css'
import type { ComponentType } from 'react'
import { ConfirmCard, selectConfirm } from './ConfirmCard.tsx'
import type { ClientContext } from './host-types.ts'
import { en, NS, zh } from './locales.ts'
import { NoticeChip, noticeDefinition } from './notice.tsx'
import { RUN_TAB_ID, RUN_TAB_KIND, RunPane } from './RunPane.tsx'
import { RUN_NODE_KIND, RunNode, runNodeDefinition } from './RunNode.tsx'
import { FillHoleRow, WorkflowToolCard } from './WorkflowToolCard.tsx'

export const inject = ['slots', 'locale', 'uiConversation']

const SUBAGENT_CHAT = 'dsh-resource://subagentchat/session/'

function subagentChatAddress(parentSessionId: string, childSessionId: string): string {
  return `${SUBAGENT_CHAT}${encodeURIComponent(childSessionId)}?${new URLSearchParams({ parent: parentSessionId, mode: 'unknown' })}`
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dynamic-workflow: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(noticeDefinition as never), 'dynamic-workflow: notice definition')
  ctx.effect(() => ctx.uiConversation.events.register(runNodeDefinition as never), 'dynamic-workflow: run node definition')

  /** Open a workflow subagent's transcript: aside in the right sidebar when possible, else in the main panel. */
  const openChild = (parentSessionId: string, childSessionId: string): void => {
    const sidebar = ctx.get('sidebarRight') as ClientContext['sidebarRight'] | undefined
    try {
      if (sidebar?.openResourceIn !== undefined) {
        sidebar.openResourceIn(parentSessionId, subagentChatAddress(parentSessionId, childSessionId), { kind: 'subagentchat' })
        return
      }
    } catch (error) {
      ctx.logger?.warn('dynamic-workflow: subagent chat tab unavailable, opening the session instead', error)
    }
    const workspace = ctx.get('uiWorkspace') as ClientContext['uiWorkspace'] | undefined
    workspace?.openSession({ parentSessionId, childSessionId, mode: 'unknown' })
  }
  const openRun = (sessionId: string, runId: string): void => {
    const sidebar = ctx.get('sidebarRight') as ClientContext['sidebarRight'] | undefined
    sidebar?.openTabIn(sessionId, RUN_TAB_KIND, { params: { sessionId, runId } })
  }
  const cardInject = (sessionId: string) => ({
    openChild: (childSessionId: string) => openChild(sessionId, childSessionId),
    openRun: (runId: string) => openRun(sessionId, runId),
  })

  ctx.slots.inject('tool.call.toolview', function* () {
    for (const key of ['create_workflow', 'amend_workflow']) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS, inject: cardInject as never }, WorkflowToolCard as ComponentType<never>)
    }
    yield ctx.slots.register({ name: 'tool.call.toolview', key: 'fill_workflow_hole', locale: NS, inject: cardInject as never }, FillHoleRow as ComponentType<never>)
  })

  ctx.slots.inject('conversation.composer', () => ctx.slots.register({
    name: 'conversation.composer',
    priority: -1,
    locale: NS,
    select: selectConfirm,
  }, ConfirmCard as ComponentType<never>))

  ctx.slots.inject('conversation.chat.node', function* () {
    yield ctx.slots.register({
      name: 'conversation.chat.node',
      key: 'dynamic-workflow-notice',
      locale: NS,
    }, NoticeChip as ComponentType<never>)
    yield ctx.slots.register({
      name: 'conversation.chat.node',
      key: RUN_NODE_KIND,
      locale: NS,
      inject: cardInject as never,
    }, RunNode as ComponentType<never>)
  })

  // The run pane needs the right sidebar; without it the card's "Open details" is a no-op.
  ctx.inject(['sidebarRightTabs', 'slots'], (scope) => {
    scope.effect(() => scope.sidebarRightTabs!.register({
      id: RUN_TAB_ID,
      kind: RUN_TAB_KIND,
      priority: 'extension',
      title: () => 'Workflow',
    }), 'dynamic-workflow: run tab type')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab',
      key: RUN_TAB_ID,
      locale: NS,
      inject: ((sessionId: string) => ({ openChild: (childSessionId: string) => openChild(sessionId, childSessionId) })) as never,
    }, RunPane as ComponentType<never>))
  })
}
