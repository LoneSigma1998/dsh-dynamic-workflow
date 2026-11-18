/**
 * The bounded display payload the GUI draws a workflow from (confirmation
 * card, tool row, run card, run pane). Browser-safe: no Node imports.
 * Mirrors ZCode `contracts/src/tools/create-workflow.ts` (Apache-2.0) as plain types.
 */

export const CREATE_WORKFLOW_GRAPH_MAX_STEPS = 64
export const CREATE_WORKFLOW_GRAPH_MAX_LANES = 32
export const CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS = 64
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS = 256
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES = 8
export const CREATE_WORKFLOW_GRAPH_MAX_PHASES = 32
export const CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES = 128
export const CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS = 64
export const CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS = 128
export const CREATE_WORKFLOW_GRAPH_MAX_HOLES = CREATE_WORKFLOW_GRAPH_MAX_PHASES
export const CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS = 100
export const CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS = 2048

export interface CreateWorkflowNamePattern { head?: string; tail?: string }

export interface CreateWorkflowStep {
  id: string
  kind: 'ask' | 'world-read' | 'hole'
  label: string
  labelPattern?: CreateWorkflowNamePattern
  line?: number
  column?: number
  lane: string
  lanes?: string[]
  source?: string
  phase?: string
  repeat?: 'stack' | 'serial'
  fill?: string
}

export interface CreateWorkflowLane {
  id: string
  name?: string
  namePattern?: CreateWorkflowNamePattern
  line?: number
  column?: number
}

export interface CreateWorkflowEdge { from: string; to: string; back?: true }
export interface CreateWorkflowStream { from: string; to: string }

export interface CreateWorkflowParticipant {
  id: string
  phase: string
  lane: string
  steps: string[]
  member?: { index: number; of: number }
  many?: true
}

export interface CreateWorkflowHandoff extends CreateWorkflowEdge { types?: string[] }

export interface CreateWorkflowPhase {
  id: string
  name?: string
  line?: number
  column?: number
  alongside?: string[]
  fill?: string
}

export interface CreateWorkflowHole {
  siteId: string
  name: string
  type: string
  phase?: string
  tail?: true
}

export interface CreateWorkflowCausalityGraph {
  steps: CreateWorkflowStep[]
  lanes: CreateWorkflowLane[]
  participants: CreateWorkflowParticipant[]
  handoffs: CreateWorkflowHandoff[]
  phases?: CreateWorkflowPhase[]
  phaseEdges?: CreateWorkflowEdge[]
  phaseStreams?: CreateWorkflowStream[]
  exits?: string[]
  sink?: string[]
  holes?: CreateWorkflowHole[]
  truncated?: boolean
}

export interface CreateWorkflowDiagnostic { line: number; column: number; code: number; message: string }

/** What a launch tool's result carries for the GUI (`ToolResult.meta`). */
export interface WorkflowLaunchDisplay {
  kind: 'dynamic-workflow-launch'
  tool: string
  ok: boolean
  name?: string
  runId?: string
  supersededRunId?: string
  errorCount: number
  diagnostics: CreateWorkflowDiagnostic[]
  causalityGraph?: CreateWorkflowCausalityGraph
  scriptPath?: string
  maxConcurrency?: number
  subagentModel?: string
  fill?: { siteId: string; name: string }
  retuned?: { previous?: number; applied: number }
  denied?: { reason: 'denied' | 'refined'; feedback?: string }
}
