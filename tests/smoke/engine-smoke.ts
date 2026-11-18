/**
 * Offline smoke test of the vendored ZCode pipeline: analyze → compile once →
 * run the lowered script in the real sandbox child process against an
 * autonomous fake driver, with the real SQLite journal. Exits non-zero on any
 * unexpected outcome. Run: `tsx tests/smoke/engine-smoke.ts`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeWorkflowScript, InMemoryJournalStore, validate, type JsonSchema } from '@zcode/dynamic-workflow'
import { runWorkflowScript } from '@zcode/dynamic-workflow-runtime'
import { AutoDriver } from '../../vendor/dynamic-workflow-runtime/tests/auto-driver.ts'
import { compileOnce } from '../../src/service/compile.ts'
import { createSqliteJournal } from '../../src/journal/journal.ts'
import { openJournalDatabase } from '../../src/journal/schema.ts'

const SCRIPT = `
interface Finding {
  /** Workspace-relative path. */
  file: string
  /** @minimum 1 */
  line: number
  issue: string
}
interface Review { findings: Finding[]; clean: boolean }

const reviewer = agent("Reviewer", { system: "You review TypeScript." })
const summarizer = agent("Summarizer")

phase("Review")
const files = ["a.ts", "b.ts"]
const reviews = await Promise.all(files.map((f) => reviewer.ask<Review>(\`Review \${f}\`)))
for (const r of reviews) for (const f of r.findings) report(f)

phase("Summarize")
const summary = await summarizer.ask(\`Summarize \${reviews.length} reviews\`)
log("done")
return { summary, total: reviews.reduce((n, r) => n + r.findings.length, 0) }
`

async function main(): Promise<void> {
  const analysis = analyzeWorkflowScript(SCRIPT)
  assert.equal(analysis.ok, true, `analysis diagnostics: ${JSON.stringify(analysis.diagnostics)}`)
  assert.ok(analysis.causality !== undefined, 'causality graph')
  const bad = analyzeWorkflowScript('const x: number = "s"; return x')
  assert.equal(bad.ok, false)
  console.log('analyze: ok; bad script diagnostics =', bad.diagnostics.map(d => `L${d.line}:C${d.column} ${d.message}`))

  const compiled = compileOnce(SCRIPT)
  console.log('compile: asks =', [...compiled.askSpecs.keys()], 'phases =', compiled.phases.phaseNames)

  const dir = mkdtempSync(join(tmpdir(), 'dwf-smoke-'))
  try {
    for (const journalKind of ['memory', 'sqlite'] as const) {
      const journal = journalKind === 'memory' ? new InMemoryJournalStore() : createSqliteJournal(openJournalDatabase(join(dir, 'journal.sqlite')))
      let driver: AutoDriver | undefined
      const settlement = await runWorkflowScript({
        runId: `dwfrun-smoke-${journalKind}`,
        scriptText: SCRIPT,
        lowered: compiled.lowered,
        scriptHash: compiled.scriptHash,
        askSpecs: compiled.askSpecs,
        sitePhases: compiled.sitePhases,
        caps: { maxConcurrency: 4 },
        cwd: dir,
        validate: (schema, value) => validate(schema as JsonSchema, value),
        makeDriver: (sink) => {
          driver = new AutoDriver(journal, {
            asks: {
              'ask#1': ({ instance }) => [
                // first submit violates @minimum; the engine rejects, the "model" repairs
                { type: 'submit', payload: { findings: [{ file: 'a.ts', line: 0, issue: 'x' }], clean: false } },
                { type: 'submit', payload: { findings: [{ file: `f${instance.ordinal}.ts`, line: 3, issue: 'unused import' }], clean: false }, stats: { tokens: 100, toolCalls: 1, turns: 1 } },
              ],
              'ask#2': () => ({ type: 'text', finalText: 'All good.', stats: { tokens: 50, toolCalls: 0, turns: 1 } }),
            },
          })
          driver.attach(sink)
          return driver
        },
      })
      assert.equal(settlement.status, 'completed', JSON.stringify(settlement))
      const artifact = (settlement as { artifact?: unknown }).artifact as { summary: string; total: number }
      assert.deepEqual(artifact, { summary: 'All good.', total: 2 })
      const types = (driver?.events ?? []).map(e => e.type)
      assert.ok(types.includes('node-repairing'), 'repair round happened')
      const reports = journal.listNodes(`dwfrun-smoke-${journalKind}`, { kinds: ['report'], withResult: true })
      assert.equal(reports.length, 2)
      console.log(`run[${journalKind}]: ${settlement.status}`, artifact, 'events:', types.length, 'tokens:', journal.getRun(`dwfrun-smoke-${journalKind}`)?.spentTokens)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('SMOKE OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
