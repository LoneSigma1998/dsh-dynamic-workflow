/**
 * Fixtures for the Web preview harness, all produced by the real code paths:
 *   - every ```ts example of the bundled skill, analyzed by the vendored compiler and bounded into
 *     the launch display exactly as create_workflow does (graphs for the confirm card / draft);
 *   - a real run captured by the DSH integration test (DWF_FIXTURE_DIR=… tests/dsh/integration.ts):
 *     the launch display from the tool result's meta, the call arguments, and the progress records.
 * Run: tsx --tsconfig <paths config> tests/preview/make-fixtures.ts <run-main.json> <out.json>
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeWorkflowScript } from '@zcode/dynamic-workflow'
import { displayOf } from '../../src/tools/tools.ts'

const [runPath, outPath] = process.argv.slice(2)
if (runPath === undefined || outPath === undefined) throw new Error('usage: make-fixtures.ts <run-main.json> <out.json>')

const root = join(import.meta.dirname, '..', '..')
const examples = readFileSync(join(root, 'skills/dynamic-workflows/examples.md'), 'utf8')
const blocks = [...examples.matchAll(/^#{2,4}\s+(.+)$[\s\S]*?```ts\n([\s\S]*?)```/gmu)]
const graphs: { title: string; script: string; display: unknown; phases: number; agents: number }[] = []
for (const [, title, script] of blocks) {
  const analysis = analyzeWorkflowScript(script!)
  if (!analysis.ok) continue
  const display = displayOf('create_workflow', analysis, { name: title!.trim(), maxConcurrency: 8 })
  const graph = display.causalityGraph
  if (graph === undefined) continue
  graphs.push({ title: title!.trim(), script: script!, display, phases: graph.phases?.length ?? 0, agents: graph.lanes.filter(l => l.id !== 'workspace' && l.id !== 'unknown').length })
}
const bad = analyzeWorkflowScript('const x: number = "nope"\nconst r = await agent("A").ask<{ ok: boolean }>(1)\nreturn x')
const run = JSON.parse(readFileSync(runPath, 'utf8')) as { display: unknown; call: { callId: string; arguments: string }; progress: unknown[]; notices: unknown[] }
writeFileSync(outPath, JSON.stringify({
  graphs,
  diagnostics: displayOf('create_workflow', bad, { name: 'broken-script' }),
  run,
}))
console.log(`fixtures: ${graphs.length} example graphs (${graphs.map(g => `${g.title} [${g.phases}p/${g.agents}a]`).join('; ')}), run with ${run.progress.length} progress records`)
