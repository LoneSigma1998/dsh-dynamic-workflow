/**
 * Quota auto-resume (fake clock): a quota stop with a reset time is resumed one margin after
 * the reset; a row changed in the meantime wins; a reset time that does not move is not
 * resumed again; a transient refusal is retried; reset times are parsed from Retry-After or
 * the provider message.
 * Run: tsx --tsconfig <paths config> tests/dsh/quota-resume.ts
 */

import assert from 'node:assert/strict'
import type { RunRecord } from '@zcode/dynamic-workflow'
import { quotaResetAt } from '../../src/driver/model-failure.ts'
import { QUOTA_RESUME_MARGIN_MS, quotaResumeAt, startQuotaAutoResume, type QuotaResumeResult } from '../../src/service/quota-resume.ts'

class FakeClock {
  t = 1_800_000_000_000
  private seq = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()
  now = (): number => this.t
  schedule = (callback: () => void, delayMs: number): (() => void) => {
    const id = this.seq++
    this.timers.set(id, { at: this.t + delayMs, callback })
    return () => this.timers.delete(id)
  }
  async advance(ms: number): Promise<void> {
    const target = this.t + ms
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (due === undefined) break
      this.timers.delete(due[0])
      this.t = due[1].at
      due[1].callback()
      await new Promise(resolve => setImmediate(resolve))
    }
    this.t = target
    await new Promise(resolve => setImmediate(resolve))
  }
}

function quotaRow(runId: string, resetAt: number): RunRecord {
  return { runId, status: 'stopped', stopReason: 'provider', failure: { code: 'ProviderStop', message: 'quota', providerStop: { kind: 'quota', reason: 'QUOTA', resetAt } } } as unknown as RunRecord
}

async function main(): Promise<void> {
  // parsing
  const now = Date.parse('2026-11-18T09:53:00+08:00')
  assert.equal(quotaResetAt({ code: 'QUOTA', message: 'x', providerRetryAfterMs: 3_600_000 }, now), now + 3_600_000)
  assert.equal(quotaResetAt({ code: 'QUOTA', message: '[1308] 您的限额将在 2026-11-18 10:50:42 重置。' }, now), Date.parse('2026-11-18T10:50:42+08:00'))
  assert.equal(quotaResetAt({ code: 'QUOTA', message: 'Quota resets at 2026-11-18T03:00:00Z' }, now), Date.parse('2026-11-18T03:00:00Z'))
  assert.equal(quotaResetAt({ code: 'QUOTA', message: 'request 2026-11-18 10:50:42 failed' }, now), undefined, 'no reset wording → no time')
  assert.equal(quotaResetAt({ code: 'QUOTA', message: 'resets 2031-01-01 00:00:00' }, now), undefined, 'implausible window')
  assert.equal(quotaResumeAt(quotaRow('r', 1000)), 1000 + QUOTA_RESUME_MARGIN_MS)
  assert.equal(quotaResumeAt({ status: 'stopped', stopReason: 'user' } as RunRecord), undefined)
  console.log('✓ quota reset parsing (Retry-After, CN message as UTC+8, ISO Z, guards)')

  // scheduling
  const clock = new FakeClock()
  const rows = new Map<string, RunRecord>()
  const resumed: string[] = []
  let settle: (notice: { runId: string }) => void = () => undefined
  let nextResult: QuotaResumeResult = { ok: true }
  rows.set('cold', quotaRow('cold', clock.t - 5_000)) // already past: resumes on the next tick after the margin
  rows.set('other', { runId: 'other', status: 'stopped', stopReason: 'user' } as unknown as RunRecord)
  const auto = startQuotaAutoResume({
    journal: { getRun: id => rows.get(id), listRunRows: () => [...rows.keys()].map(runId => ({ runId })) },
    subscribeRunSettled: (listener) => { settle = listener; return () => { settle = () => undefined } },
    resume: async (runId) => { resumed.push(runId); return nextResult },
    clock,
  })
  assert.deepEqual(auto.armed(), ['cold'], 'cold-start scan arms only the quota stop')
  await clock.advance(QUOTA_RESUME_MARGIN_MS)
  assert.deepEqual(resumed, ['cold'])
  console.log('✓ cold-start scan resumed a quota stop whose reset had passed')

  // a settled quota stop arms a timer; a manual resume before it fires wins
  rows.set('live', quotaRow('live', clock.t + 3_600_000))
  settle({ runId: 'live' })
  assert.ok(auto.armed().includes('live'))
  rows.set('live', { runId: 'live', status: 'running' } as unknown as RunRecord)
  await clock.advance(3_600_000 + QUOTA_RESUME_MARGIN_MS)
  assert.deepEqual(resumed, ['cold'], 'row changed (manually resumed) → no auto-resume')
  console.log('✓ the journal row wins over the timer (manual resume before the reset)')

  // same reset time again after an auto-resume → no loop
  rows.set('cold', quotaRow('cold', clock.t - 3_600_000 - 5_000 - QUOTA_RESUME_MARGIN_MS * 2))
  const first = quotaResumeAt(rows.get('cold'))!
  rows.set('loop', quotaRow('loop', clock.t))
  settle({ runId: 'loop' })
  await clock.advance(QUOTA_RESUME_MARGIN_MS)
  assert.equal(resumed.filter(id => id === 'loop').length, 1)
  settle({ runId: 'loop' }) // stopped again with the same reset time
  await clock.advance(QUOTA_RESUME_MARGIN_MS * 3)
  assert.equal(resumed.filter(id => id === 'loop').length, 1, 'a reset time that did not move is not resumed again')
  void first
  console.log('✓ no loop when the provider reports the same reset time again')

  // transient refusal → bounded retry
  nextResult = { ok: false, reason: 'already_running' }
  rows.set('busy', quotaRow('busy', clock.t))
  settle({ runId: 'busy' })
  await clock.advance(QUOTA_RESUME_MARGIN_MS)
  nextResult = { ok: true }
  await clock.advance(QUOTA_RESUME_MARGIN_MS)
  assert.equal(resumed.filter(id => id === 'busy').length, 2, 'retried once after already_running')
  console.log('✓ transient refusal retried after one margin')

  auto.dispose()
  assert.deepEqual(auto.armed(), [])
  console.log('QUOTA RESUME OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
