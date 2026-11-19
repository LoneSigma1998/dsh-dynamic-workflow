/**
 * `eval_workflow_snippet` runner: world reads through the real compiler + sandbox,
 * logs captured, the return value rendered; diagnostics for code outside the snippet facade.
 * Run: tsx --tsconfig <paths config> tests/dsh/snippet.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSnippetRunner } from '../../src/service/snippet.ts'

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'dwf-snippet-'))
  try {
    mkdirSync(join(cwd, 'src'))
    writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1\n')
    writeFileSync(join(cwd, 'src/b.ts'), 'export const b = 2 // TODO: drop\n')
    const runner = createSnippetRunner()

    const ok = await runner.run(`
      const found = await files.glob('src/**/*.ts')
      log(\`found \${found.length}\`)
      const text = await files.read('src/b.ts')
      const hits = await files.grep('TODO', 'src/**/*.ts')
      return { files: found.length, hasTodo: text.includes('TODO'), hits: hits.length }
    `, cwd, 60_000)
    assert.equal(ok.ok, true, ok.text)
    assert.match(ok.text, /found 2/)
    assert.match(ok.text, /"files":\s*2/)
    assert.match(ok.text, /"hasTodo":\s*true/)
    console.log('✓ snippet: glob/read/grep through the sandbox, log captured, result rendered')

    const bad = await runner.run(`const r = await agent('x').ask('y'); return r`, cwd, 30_000)
    assert.equal(bad.ok, false)
    assert.match(bad.text, /Diagnostics/)
    console.log('✓ snippet: agent() is outside the snippet facade → diagnostics, nothing runs')

    // inspect detects world.run literal commands cleanly without executing
    const roInspect = runner.inspect(`const f = await files.glob('src/**/*.ts'); return f.length`)
    assert.equal(roInspect.ok, true)
    if (roInspect.ok) assert.deepEqual(roInspect.prepared.worldRunCommands, [])
    const runInspect = runner.inspect(`const out = await world.run('echo', ['hi']); return out.stdout.trim()`)
    assert.equal(runInspect.ok, true)
    if (runInspect.ok) assert.deepEqual(runInspect.prepared.worldRunCommands, ['echo'])
    console.log('✓ snippet: inspect() extracts world.run commands accurately')

    // aborting a snippet kills its world.run child process instead of hanging for 30 s
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(new Error('cancelled')), 250)
    const cancelled = await runner.run(`await world.run('sleep', ['30'], { timeoutMs: 60_000 }); return 'done'`, cwd, 60_000, controller.signal)
    assert.equal(cancelled.ok, false)
    assert.ok(Date.now() - started < 5_000, `snippet abort took ${Date.now() - started} ms`)
    console.log(`✓ snippet: aborting killed a 30 s world.run in ${Date.now() - started} ms`)
    console.log('SNIPPET OK')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
