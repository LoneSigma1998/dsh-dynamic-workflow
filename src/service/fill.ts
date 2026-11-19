/**
 * `fill_workflow_hole`: splice a body into an open hole of a live run, check
 * the effective script and the stability of every existing site id, then hand
 * the lowered body to the engine — which releases the parked branch in place.
 * Ported from ZCode `bootstrap/src/app/dynamic-workflow-run-fill.ts` (Apache-2.0).
 * Fills of one run are serialized; every refusal has zero side effects.
 */

import { writeFileSync } from 'node:fs'
import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectPhaseNames,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  interpret,
  projectControlFlow,
  spliceHoleBody,
  synthesizeAskSchemas,
  type CompileDiagnostic,
} from '@zcode/dynamic-workflow'
import { compileProgram, type CompiledScript } from './compile.ts'
import type { LiveRun } from './run-service.ts'

export type FillResult =
  | { ok: true; phasesAdded: string[]; scriptPath?: string; scriptText: string }
  | { ok: false; reason: 'run_not_found' | 'hole_not_waiting' | 'compile_failed' | 'fill_ids_unstable'; message: string; diagnostics?: CompileDiagnostic[] }

export function fillHole(entry: LiveRun | undefined, input: { runId: string; holeId: string; body: string; filledBy?: string }): Promise<FillResult> {
  if (entry === undefined) {
    return Promise.resolve({ ok: false, reason: 'hole_not_waiting', message: `Run ${input.runId} is not in flight in this process; resume it first and the hole will ask again.` })
  }
  const turn = entry.fillQueue.then(() => fillOnce(entry, input), () => fillOnce(entry, input))
  entry.fillQueue = turn.then(() => undefined, () => undefined)
  return turn
}

async function fillOnce(entry: LiveRun, input: { runId: string; holeId: string; body: string; filledBy?: string }): Promise<FillResult> {
  const { holeId } = input
  if (entry.engine === undefined) return { ok: false, reason: 'hole_not_waiting', message: `Run ${input.runId} has no live engine.` }
  const scriptText = entry.scriptText
  const workflow = createWorkflowProgram(scriptText)
  const before = collectSites(workflow)
  const site = before.holes.find(hole => hole.id === holeId)
  if (site === undefined) {
    const known = before.holes.map(hole => `${hole.id} (${hole.name ?? '?'})`).join(', ')
    return { ok: false, reason: 'hole_not_waiting', message: `${holeId} is not a hole of run ${input.runId}${known === '' ? '' : `; its holes are ${known}`}.` }
  }
  if (site.body !== undefined) return { ok: false, reason: 'hole_not_waiting', message: `${holeId} of run ${input.runId} is already filled.` }
  const spliced = spliceHoleBody(scriptText, before, holeId, input.body)
  if (spliced === undefined) return { ok: false, reason: 'hole_not_waiting', message: `${holeId} of run ${input.runId} cannot take a body.` }
  const analysis = analyzeWorkflowScript(spliced.text)
  if (!analysis.ok) {
    return {
      ok: false,
      reason: 'compile_failed',
      message: `The effective script does not compile (${analysis.diagnostics.length} diagnostic${analysis.diagnostics.length === 1 ? '' : 's'}); nothing was spliced and the hole is still waiting.`,
      diagnostics: analysis.diagnostics.map(diagnostic => mapToBody(diagnostic, spliced.insertedAtLine, spliced.insertedLines)),
    }
  }
  const effective = createWorkflowProgram(spliced.text)
  const after = collectSites(effective)
  // Schema synthesis (9002) and non-literal world.run commands (9003) are not checked by
  // analyzeWorkflowScript: report them as structured compile_failed diagnostics instead of throwing.
  const extraDiagnostics = [
    ...synthesizeAskSchemas(effective, after).diagnostics,
    ...collectWorldRunCommands(effective, after).diagnostics,
  ]
  if (extraDiagnostics.length > 0) {
    return {
      ok: false,
      reason: 'compile_failed',
      message: `The effective script did not compile (${extraDiagnostics.length} diagnostic${extraDiagnostics.length === 1 ? '' : 's'}); nothing was spliced and the hole is still waiting.`,
      diagnostics: extraDiagnostics.map(diagnostic => mapToBody(diagnostic, spliced.insertedAtLine, spliced.insertedLines)),
    }
  }
  const stability = checkSiteStability(before, after, holeId, spliced.insertedAtLine, spliced.insertedLines)
  if (!stability.ok) {
    return { ok: false, reason: 'fill_ids_unstable', message: `The compiled effective script renumbered an existing site (${stability.detail}). This is a host fault, not a problem with the body; the hole is still waiting.` }
  }
  let compiled: CompiledScript
  try {
    compiled = compileProgram(spliced.text, effective, after)
  } catch (error) {
    return {
      ok: false,
      reason: 'compile_failed',
      message: `${error instanceof Error ? error.message : String(error)}; nothing was spliced and the hole is still waiting.`,
    }
  }
  const code = compiled.holeBodies[holeId]
  if (code === undefined) return { ok: false, reason: 'fill_ids_unstable', message: `Lowering produced no body for ${holeId}; the hole is still waiting.` }
  const result = entry.engine.fillHole({
    siteId: holeId,
    code,
    script: { text: spliced.text, hash: compiled.scriptHash },
    askSpecs: compiled.askSpecs,
    sitePhases: compiled.sitePhases,
    phaseNames: compiled.phases.phaseNames,
    ...compiled.phases.holes.length === 0 ? {} : { holes: compiled.phases.holes },
    ...input.filledBy === undefined ? {} : { filledBy: input.filledBy },
  })
  if (result === undefined || !result.ok) {
    return {
      ok: false,
      reason: 'hole_not_waiting',
      message: result?.reason === 'settled'
        ? `Run ${input.runId} has already settled; nothing is waiting.`
        : `Run ${input.runId} is not waiting at ${holeId}: it has not reached it yet, or it is already filled.`,
    }
  }
  const previousPhases = new Set(collectPhaseNames(projectControlFlow(interpret(workflow, before))).phaseNames)
  entry.scriptText = spliced.text
  entry.compiled = compiled
  if (entry.scriptPath !== undefined) {
    try {
      writeFileSync(entry.scriptPath, spliced.text, 'utf8')
    } catch {
      // best effort: the draft keeps its old content, the run has the effective script
    }
  }
  return {
    ok: true,
    phasesAdded: compiled.phases.phaseNames.filter(name => !previousPhases.has(name)),
    ...entry.scriptPath === undefined ? {} : { scriptPath: entry.scriptPath },
    scriptText: spliced.text,
  }
}

/** Diagnostics inside the spliced range are reported against the body's own lines. */
function mapToBody(diagnostic: CompileDiagnostic, insertedAtLine: number, insertedLines: number): CompileDiagnostic {
  if (diagnostic.line >= insertedAtLine && diagnostic.line < insertedAtLine + insertedLines) {
    return { ...diagnostic, line: diagnostic.line - insertedAtLine + 1, message: `(in the body) ${diagnostic.message}` }
  }
  return { ...diagnostic, message: `(in the script) ${diagnostic.message}` }
}
