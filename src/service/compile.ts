/**
 * "Compile once": one `ts.Program` feeds the site table, schema synthesis,
 * lowering, submit profiles and the lexical phase table. Ported from ZCode
 * `bootstrap/src/app/dynamic-workflow-run-compile.ts` (Apache-2.0).
 *
 * A dirty script never reaches here (the tool returns the analyzer's
 * diagnostics first); hitting one is a wiring error and throws without
 * creating a run. The script hash is computed on the author's text, never on
 * the lowered body, so resume compares like with like.
 */

import { createHash } from 'node:crypto'
import {
  buildAskSpecs,
  collectPhaseNames,
  collectSitePhases,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  deriveActorSubmitProfiles,
  interpret,
  lowerWorkflow,
  projectControlFlow,
  synthesizeAskSchemas,
  type ActorSubmitProfile,
  type AskSpec,
  type CompileDiagnostic,
  type SiteTable,
  type WorkflowProgram,
} from '@zcode/dynamic-workflow'
import { projectSiteGraph } from '@zcode/dynamic-workflow/projections'
import { collectActorModels } from '../../vendor/dynamic-workflow/src/analysis/actor-models.ts'

export interface CompiledHole {
  siteId: string
  name: string
  type: string
  line: number
  open: boolean
}

export interface CompiledScript {
  lowered: string
  scriptHash: string
  askSpecs: Map<string, AskSpec>
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>
  sitePhases: ReadonlyMap<string, string>
  holeBodies: Readonly<Record<string, string>>
  holes: readonly CompiledHole[]
  phases: { phaseNames: string[]; holes: number[] }
  /** Distinct model names the script hands to subagents (`model("…")` / persona `model`). */
  modelReferences: string[]
}

export function compileOnce(scriptText: string): CompiledScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText))
}

export function compiledHolesOf(table: SiteTable): CompiledHole[] {
  return table.holes.map(site => ({
    siteId: site.id,
    name: site.name ?? site.id,
    type: site.typeText ?? 'unknown',
    line: site.loc.line,
    open: site.body === undefined,
  }))
}

export function boundedDiagnostics(diagnostics: readonly CompileDiagnostic[], max = 2000): string {
  const body = diagnostics.map(d => `L${d.line}:C${d.column} ${d.message}`).join('\n')
  return body.length > max ? `${body.slice(0, max - 1)}…` : body
}

export function compileProgram(scriptText: string, workflow: WorkflowProgram, collected?: SiteTable): CompiledScript {
  const diagnostics = [...workflow.program.getSyntacticDiagnostics(), ...workflow.program.getSemanticDiagnostics()]
  if (diagnostics.length > 0) {
    throw new Error(`dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`)
  }
  const table = collected ?? collectSites(workflow)
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table)
  if (schemaDiagnostics.length > 0) {
    throw new Error(`dynamic workflow submit received a script with unsupported ask result types: ${boundedDiagnostics(schemaDiagnostics)}`)
  }
  const worldRun = collectWorldRunCommands(workflow, table)
  if (worldRun.diagnostics.length > 0) {
    throw new Error(`dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`)
  }
  const askSpecs = buildAskSpecs(table, schemas)
  const core = interpret(workflow, table)
  const lowered = lowerWorkflow(workflow, table)
  const models = collectActorModels(workflow, table)
  return {
    askSpecs,
    actorSubmitProfiles: deriveActorSubmitProfiles(projectSiteGraph(core), askSpecs),
    sitePhases: collectSitePhases(core),
    lowered: lowered.code,
    holeBodies: lowered.holeBodies,
    holes: compiledHolesOf(table),
    phases: collectPhaseNames(projectControlFlow(core)),
    modelReferences: [...new Set(models.references.map(reference => reference.name))],
    scriptHash: createHash('sha256').update(scriptText, 'utf8').digest('hex'),
  }
}
