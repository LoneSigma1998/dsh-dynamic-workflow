/**
 * Unit test of the adaptive governor over fake streams: governed requests queue
 * at the cap, observers never queue, a 429 cuts the cap once per epoch, and
 * four clean successes with demand waiting raise it again.
 * Run: tsx --tsconfig <paths config> tests/dsh/governor.ts
 */

import assert from 'node:assert/strict'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ConcurrencyGovernor } from '../../src/governor/governor.ts'

function request(sessionId: string): GenerateOptions {
  return { provider: 'p', model: 'm', messages: [], sessionId } as unknown as GenerateOptions
}

function gatedStream(gate: Promise<'ok' | '429'>, started: () => void, finished: () => void = () => undefined): () => AsyncIterable<StreamChunk> {
  return async function * () {
    started()
    const outcome = await gate
    finished()
    yield (outcome === 'ok'
      ? { type: 'finish', reason: { kind: 'stop' } }
      : { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429' } } }) as StreamChunk
  }
}

async function drain(iterable: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of iterable) { /* consume */ }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

async function main(): Promise<void> {
  const changes: string[] = []
  const governor = new ConcurrencyGovernor({ initial: 2, growthLimit: 4, onChange: c => changes.push(`${c.previous}->${c.next}:${c.reason}`) })
  let running = 0
  let peak = 0
  const releases: ((value: 'ok' | '429') => void)[] = []
  const runs: Promise<void>[] = []
  for (let i = 0; i < 5; i += 1) {
    const gate = new Promise<'ok' | '429'>(resolve => releases.push(resolve))
    runs.push(drain(governor.govern(request(`dwf-run-actor_${i}`), gatedStream(gate, () => { running += 1; peak = Math.max(peak, running) }, () => { running -= 1 }))))
  }
  await tick()
  assert.equal(running, 2, 'only the cap of governed requests start')
  // an observer (main agent) is never queued
  let observerStarted = false
  const observer = drain(governor.govern(request('main-session'), gatedStream(Promise.resolve('ok'), () => { observerStarted = true })))
  await tick()
  assert.equal(observerStarted, true, 'observer passes the full bucket')
  await observer
  // a 429 cuts the cap 2 → 1
  releases[0]!('429')
  await tick()
  assert.ok(changes.some(c => c.startsWith('2->1:rate_limited')), `changes: ${changes.join(', ')}`)
  const snapshot = governor.snapshot()[0]!
  assert.equal(snapshot.cap, 1)
  // finish the rest successfully, one at a time
  for (let i = 1; i < 5; i += 1) {
    releases[i]!('ok')
    await tick()
  }
  await Promise.all(runs)
  assert.ok(peak <= 2, `peak in flight ${peak}`)
  console.log(`✓ governor: queued at cap 2, observer bypassed, 429 cut to 1, peak=${peak}, changes=[${changes.join(', ')}]`)
  // recovery: four successes with waiters raise the cap
  const releases2: ((value: 'ok' | '429') => void)[] = []
  const runs2: Promise<void>[] = []
  for (let i = 0; i < 8; i += 1) {
    const gate = new Promise<'ok' | '429'>(resolve => releases2.push(resolve))
    runs2.push(drain(governor.govern(request(`dwf-run-actor_${i}`), gatedStream(gate, () => undefined))))
  }
  for (let i = 0; i < 8; i += 1) {
    await tick()
    releases2[i]!('ok')
  }
  await Promise.all(runs2)
  assert.ok(changes.some(c => c.endsWith(':recovered')), `expected a recovery: ${changes.join(', ')}`)
  console.log(`✓ governor: recovered after a success streak with demand waiting (cap now ${governor.snapshot()[0]!.cap})`)
  governor.dispose()
  console.log('GOVERNOR OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
