/**
 * Structural subset of the DSH Web client types this plugin touches.
 *
 * An out-of-repo client bundle may only `require` the shell's platform modules; every other
 * `@deepseek-ai/dsh-client-*` import must be type-only. Rather than pull those packages' whole
 * type graphs (they are workspace-versioned), the few shapes used here are written down
 * structurally, each with the DSH source it mirrors.
 */

import type { ComponentType, ReactNode } from 'react'
import type { WorkflowRunsState } from '../shared/runs/workflow-runs.ts'

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** packages/util/values/src/partial-json.ts — the lazy reader over streaming tool arguments. */
export interface PartialArguments {
  readonly isSealed: boolean
  closed(): boolean
  has(key: string): boolean
  complete(key: string): boolean
  text(key: string): string | undefined
  textPrefix(key: string, maxLength: number): string | undefined
  value(key: string): unknown
}

/** packages/client/ui-conversation/src/client/contract/records.ts */
export interface ToolCallHead {
  callId: string
  name: string
  turn: number
  step: number
  time: number
  args: PartialArguments
}
export interface ToolResultBlock {
  kind: 'tool-result'
  seq: number
  time: number
  callId: string
  name: string
  args: PartialArguments
  call: { name: string; argsRaw: string } | null
  content: readonly { type: string; text?: string }[]
  isError: boolean
  error?: { name: string; code: string; reason?: string }
  meta?: unknown
}

export interface UseDisclosureResult { readonly expanded: boolean; readonly setExpanded: (open: boolean) => void; readonly toggle: () => void }

export type UseProjection = <S>(key: 'dynamicWorkflowRuns', selector?: (value: WorkflowRunsState | undefined) => S, eq?: (a: S, b: S) => boolean) => S

/** packages/client/ui-tool/src/client/contract/slots.ts — `tool.call.toolview` owner props + session kit. */
export type ToolCallViewProps = {
  callId: string
  toolName: string
  cwd?: string | undefined
  useDisclosure: () => UseDisclosureResult
  inspect?: (() => void) | undefined
  sessionId: string
  useProjection: UseProjection
  t: Translate
} & (
  | { readonly phase: 'preparing'; readonly block: ToolCallHead & { phase: 'preparing' } }
  | { readonly phase: 'start'; readonly block: ToolCallHead & { phase: 'start'; argsRaw: string } }
  | { readonly phase: 'result'; readonly block: ToolResultBlock }
)

/** ui-user-questions PendingQuestion (public members only). */
export interface PendingQuestionLike {
  readonly kind: 'question' | 'plan-review'
  readonly key: string
  readonly sessionId: string
  readonly questions: readonly { id: string; question: string; header?: string; detail?: string; options?: { label: string; description?: string }[] }[]
  snapshot(): { channel: 'waterfall' | 'rpc' | 'none'; closed: boolean }
  subscribe(listener: () => void): () => void
  getSnapshot(): { channel: 'waterfall' | 'rpc' | 'none'; closed: boolean }
  answer(answer: { answers: { id: string; selected: string[]; custom?: string }[] }): Promise<void>
  dismiss(): Promise<void>
}

/** ui-conversation ComposerChainProps. */
export interface ComposerChainProps {
  sessionId: string | undefined
  pendingInteraction: { kind?: string; questions?: readonly { id: string }[] } | undefined
}

/** ConversationNodeDefinition (ui-conversation contract/conversation.ts), the fields used here. */
export interface SessionEventLike { type: string; seq: number; time: number; data: unknown; surfaceOp?: string }
export interface ConversationMatchResult { readonly id: string; readonly role: 'start' | 'update'; readonly exclusive?: true }
export interface ConversationStartMatch { event: SessionEventLike; role: 'start'; location: unknown }
export interface ConversationNodeContext<State> {
  readonly key: string
  readonly kind: string
  readonly id: string
  readonly start: ConversationStartMatch | undefined
  readonly state: State | undefined
}
export interface ConversationNodeDefinition<State> {
  readonly kind: string
  readonly target?: string
  match(event: SessionEventLike): ConversationMatchResult | null
  start(context: ConversationNodeContext<State>, match: ConversationStartMatch): State
  update(context: ConversationNodeContext<State> & { readonly state: State }, match: { event: SessionEventLike }): State
  buildViewNode?(context: ConversationNodeContext<State>): unknown
}

export interface SlotRegistration {
  name: string
  key?: string
  id?: string
  priority?: number
  order?: number
  locale?: string
  select?: (owner: ComposerChainProps) => unknown
  inject?: (...args: never[]) => unknown
}

/** The client Context services this plugin injects. */
export interface ClientContext {
  effect(fn: () => (() => void) | void, label?: string): void
  inject(names: string[], callback: (scope: ClientContext) => void): void
  get(name: string): unknown
  logger?: { warn(...args: unknown[]): void }
  slots: {
    inject(name: string, callback: () => (() => void) | Generator<() => void>): void
    register(options: SlotRegistration, component: ComponentType<never>): () => void
  }
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind?(ns: string): Translate
  }
  uiConversation: { events: { register(definition: ConversationNodeDefinition<never>): () => void } }
  uiWorkspace?: { openSession(target: string | { parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' | 'unknown' }): void }
  sidebarRight?: {
    openTabIn(sessionId: string, kind: string, options?: { params?: unknown; preferNewPane?: boolean }): void
    openResourceIn?(sessionId: string, address: string, options?: { kind?: string; preferNewPane?: boolean }): void
  }
  sidebarRightTabs?: {
    register(definition: {
      id: string
      kind: string
      priority?: string
      title: (address: string) => string
      multiple?: boolean
      guide?: readonly {
        id: string
        order: number
        title: () => string
        description?: () => string
        icon?: ComponentType<{ size?: number }>
      }[]
    }): () => void
  }
}

export type Children = { children?: ReactNode }
