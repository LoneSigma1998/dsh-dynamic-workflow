#!/usr/bin/env node
/**
 * LIVE end-to-end test: the real `dsh headless` binary + this plugin + a real model behind an
 * Anthropic-compatible gateway. Nothing is scripted: the model has to load the skill, write a
 * workflow script that typechecks, the run fans out real DSH child agents, the result comes back
 * as a <task-notification>, and the session log must stay reloadable.
 *
 * Config (env, or a gitignored .env next to package.json):
 *   DWF_E2E_BASE_URL  (or ANTHROPIC_BASE_URL)          gateway root, e.g. http://host:3425
 *   DWF_E2E_API_KEY   (or ANTHROPIC_AUTH_TOKEN)        credential (never written to disk by this script)
 *   DWF_E2E_MODEL     (or ANTHROPIC_DEFAULT_OPUS_MODEL) model id, e.g. workbuddy/deepseek-v4.1-flash[1m]
 *   DSH_BIN           dsh launcher (default: `dsh` on PATH)
 *   DWF_E2E_INSTALL=1 install the package with `dsh plugin add` instead of inserting lib/index.js by path
 *   DWF_E2E_KEEP=1    keep the temp workspace and DSH_HOME
 *
 * Usage: node tests/e2e/run-live.mjs ["custom prompt"]
 *        DWF_E2E_KEEP=1 DWF_E2E_PHASE=run node tests/e2e/run-live.mjs   (time-boxed shells: run only)
 *        node tests/e2e/run-live.mjs --continue <dir>  (the run segment was cut off: reopen the same
 *                                                      session with --session-id and let it finish)
 *        node tests/e2e/run-live.mjs --verify <dir>    (check a finished kept run)
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Behind an HTTP(S) proxy (corporate network, sandboxed agents), Node's fetch only honors
// HTTP(S)_PROXY with NODE_USE_ENV_PROXY=1 (Node >= 22.21 / 24). Re-run under it, and the
// dsh child inherits it from `env` below.
if ((process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy) !== undefined && process.env.NODE_USE_ENV_PROXY === undefined) {
  const { spawnSync } = await import('node:child_process')
  const rerun = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
  process.exit(rerun.status ?? 1)
}

const log = (...args) => console.log('[e2e]', ...args)
const fail = (message) => { console.error(`\n✗ E2E FAILED: ${message}`); process.exitCode = 1 }

// ——— config ———
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/u)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line)
    if (match !== null && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/u, '$2')
  }
}
const baseURL = (process.env.DWF_E2E_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/u, '')
const apiKey = process.env.DWF_E2E_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY ?? ''
const requestedModel = process.env.DWF_E2E_MODEL ?? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? ''
if (baseURL === '' || apiKey === '' || requestedModel === '') {
  console.error('Set DWF_E2E_BASE_URL, DWF_E2E_API_KEY and DWF_E2E_MODEL (or put them in .env).')
  process.exit(2)
}
const dshBin = process.env.DSH_BIN ?? 'dsh'

// ——— 1. probe the gateway: which auth header it wants, and which spelling of the model id ———
// Claude Code model names may carry a client-side suffix such as `[1m]` (1M-context variant) that
// is not part of the wire id; try the name as given first, then without the suffix.
async function probe(auth, modelId) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth === 'x-api-key' ? { 'x-api-key': apiKey } : { authorization: `Bearer ${apiKey}` } }
  const started = Date.now()
  try {
    const response = await fetch(`${baseURL}/v1/messages`, { method: 'POST', headers, body: JSON.stringify({ model: modelId, max_tokens: 32, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }), signal: AbortSignal.timeout(60_000) })
    const text = await response.text()
    return { status: response.status, ms: Date.now() - started, text: text.slice(0, 300) }
  } catch (error) {
    // network-level failure (unreachable host, DNS, timeout): no point trying other spellings
    return { status: 0, ms: Date.now() - started, text: `${error?.cause?.code ?? ''} ${String(error?.cause?.message ?? error)}` }
  }
}
let bearer = false
let model = requestedModel
{
  const candidates = [...new Set([requestedModel, requestedModel.replace(/\[[^\]]*\]$/u, '')])]
  let chosen
  const attempts = []
  outer: for (const auth of ['x-api-key', 'bearer']) {
    for (const modelId of candidates) {
      const result = await probe(auth, modelId)
      attempts.push(`${auth} ${modelId} → HTTP ${result.status} (${result.ms} ms)${result.status >= 400 || result.status === 0 ? ` ${result.text.replace(/\s+/gu, ' ').slice(0, 160)}` : ''}`)
      if (result.status === 0) break outer
      if (result.status < 400) { chosen = { auth, modelId }; break outer }
      if (result.status === 401 || result.status === 403) break // this auth style is refused; try the other one
    }
  }
  for (const line of attempts) log(`probe ${line}`)
  if (chosen === undefined) { fail(attempts.some(line => line.includes('HTTP 0')) ? `cannot reach ${baseURL} from this machine (see probe above)` : 'the gateway refused every auth style / model spelling (see probes above)'); process.exit(1) }
  bearer = chosen.auth === 'bearer'
  model = chosen.modelId
  log(`using ${bearer ? 'Authorization: Bearer' : 'x-api-key'} with model "${model}"`)
}

// ——— 2. dsh + plugin build ———
let dshVersion
try {
  dshVersion = execFileSync(dshBin, ['--version'], { encoding: 'utf8' }).trim()
} catch (error) {
  fail(`cannot run "${dshBin}" (${String(error)}). Install DSH (Node >= 24.9) or set DSH_BIN.`)
  process.exit(1)
}
log(`dsh ${dshVersion}`)
const entry = join(root, 'lib', 'index.js')
if (!existsSync(entry) || !existsSync(join(root, 'lib', 'client.js'))) {
  log('building the plugin (node scripts/build.mjs)')
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { stdio: 'inherit', cwd: root })
}

// ——— 3. isolated DSH_HOME + a small workspace with planted bugs ———
// `--verify <dir>` re-checks a kept run (DWF_E2E_KEEP=1) without running the model again.
const verifyIndex = process.argv.indexOf('--verify')
const verifyOnly = verifyIndex > 0 ? resolve(process.argv[verifyIndex + 1]) : undefined
// `--continue <dir>`: the run segment was cut off (shell time cap): reopen its main session with
// `--session-id`. A finished run is summarized; an interrupted one comes back resumable.
const continueIndex = process.argv.indexOf('--continue')
const continueDir = continueIndex > 0 ? resolve(process.argv[continueIndex + 1]) : undefined
const temp = verifyOnly ?? continueDir ?? mkdtempSync(join(tmpdir(), 'dwf-e2e-'))
const dshHome = join(temp, 'dsh-home')
const workspace = join(temp, 'workspace')
if (verifyOnly === undefined && continueDir === undefined) {
mkdirSync(join(workspace, 'src'), { recursive: true })
writeFileSync(join(workspace, 'src', 'math.ts'), [
  'export function average(values: number[]): number {',
  '  let sum = 0',
  '  for (let i = 0; i <= values.length; i++) sum += values[i]',
  '  return sum / values.length',
  '}',
  '',
  'export function clamp(value: number, min: number, max: number): number {',
  '  return Math.max(max, Math.min(min, value))',
  '}',
  '',
].join('\n'))
writeFileSync(join(workspace, 'src', 'strings.ts'), [
  'export function capitalize(word: string): string {',
  '  return word.charAt(1).toUpperCase() + word.slice(1)',
  '}',
  '',
  'export function isBlank(text: string): boolean {',
  '  return text.trim().length > 0',
  '}',
  '',
].join('\n'))
writeFileSync(join(workspace, 'src', 'dates.ts'), [
  'export function addDays(date: Date, days: number): Date {',
  '  const next = new Date(date)',
  '  next.setDate(date.getDate() + days)',
  '  return next',
  '}',
  '',
].join('\n'))
writeFileSync(join(workspace, 'README.md'), '# sample\nA tiny TypeScript utility library used by an end-to-end test.\n')
}

const install = process.env.DWF_E2E_INSTALL === '1'
const pluginConfig = { confirm: 'never', holdTurnWhileRunning: true, skillGate: true }
const patch = [
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'dwf-e2e': {
          api: 'anthropic-messages',
          apiKeyEnv: 'DWF_E2E_API_KEY',
          baseURL,
          models: [{ id: model, maxTokens: 16384 }],
        },
      },
    },
  },
  // `dsh headless` creates its agent from the deployment default model
  { id: 'agent-default-model', config: { provider: 'dwf-e2e', model } },
  install ? { id: 'dynamic-workflow', config: pluginConfig } : { insert: [{ id: 'dynamic-workflow', name: entry, config: pluginConfig }] },
]
if (bearer) {
  // pi-ai sends the key as x-api-key; this gateway wants a bearer token. Headers are plain config,
  // so the token is written only to the temp patch file, which is deleted unless DWF_E2E_KEEP=1.
  patch[0].config.providers['dwf-e2e'].headers = { Authorization: `Bearer ${apiKey}` }
}
const patchPath = join(temp, 'e2e.patch.json')
writeFileSync(patchPath, JSON.stringify(patch, null, 2))
const env = { ...process.env, DSH_HOME: dshHome, DWF_E2E_API_KEY: apiKey, NO_COLOR: '1' }

if (install && verifyOnly === undefined && continueDir === undefined) {
  log('installing the plugin into the headless profile (dsh plugin add)')
  execFileSync(dshBin, ['plugin', '--profile', 'headless', 'add', root], { stdio: 'inherit', env, cwd: workspace })
}

// ——— 4. the real run ———
const prompt = (process.argv[2]?.startsWith('--') ? undefined : process.argv[2]) ?? '用工作流完成这个任务：审查 src/ 下的每个 .ts 文件，每个文件交给一个独立的子代理找出明确的 bug（给出行号和原因），最后再让一个子代理把所有发现汇总成一份按严重程度排序的修复清单。只读，不要修改任何文件。最后把汇总清单回复给我。'
log(`workspace ${workspace}`)
log(`DSH_HOME ${dshHome}`)
const CONTINUE_PROMPT = '继续刚才的任务：如果工作流已经结束，把汇总清单回复给我；如果它被中断了，先续跑它，结束后再回复。'
let dshArgs = ['headless', '--patch', patchPath, prompt]
if (continueDir !== undefined) {
  const sessionId = mainSessionId()
  if (sessionId === undefined) { fail(`no main session with a create_workflow call under ${continueDir}`); process.exit(1) }
  dshArgs = ['headless', '--patch', patchPath, '--session-id', sessionId, CONTINUE_PROMPT]
  log(`continuing ${sessionId}: "${CONTINUE_PROMPT.slice(0, 40)}…"`)
} else if (verifyOnly === undefined) log(`running: dsh headless --patch e2e.patch.json "${prompt.slice(0, 60)}…"`)
const started = Date.now()
const result = verifyOnly !== undefined
  ? { ...JSON.parse(readFileSync(join(temp, 'run.json'), 'utf8')), stdout: readFileSync(join(temp, 'stdout.txt'), 'utf8'), stderr: readFileSync(join(temp, 'stderr.txt'), 'utf8') }
  : await new Promise((resolvePromise) => {
  const child = spawn(dshBin, dshArgs, { cwd: workspace, env })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGTERM'), Number(process.env.DWF_E2E_TIMEOUT_MS ?? 20 * 60_000))
  child.on('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, stdout, stderr }) })
})
const seconds = result.seconds ?? ((Date.now() - started) / 1000).toFixed(0)
if (verifyOnly === undefined) {
  writeFileSync(join(temp, 'stdout.txt'), result.stdout)
  writeFileSync(join(temp, 'stderr.txt'), result.stderr)
  writeFileSync(join(temp, 'run.json'), JSON.stringify({ code: result.code, signal: result.signal, seconds }))
  if (process.env.DWF_E2E_PHASE === 'run') {
    // split mode (time-boxed shells): verify later with `--verify <dir>`
    log(`run finished; verify with: node tests/e2e/run-live.mjs --verify ${temp}`)
    process.exit(result.code === 0 ? 0 : 1)
  }
}
log(`dsh exited code=${result.code} signal=${result.signal ?? '-'} after ${seconds}s`)

// ——— 5. verify ———
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`) }
check('dsh headless exited 0', result.code === 0, result.code === 0 ? '' : result.stderr.slice(-800))
check('final answer printed', result.stdout.trim().length > 40, `${result.stdout.trim().length} chars`)
if (process.argv[2] === undefined || process.argv[2] === '--verify' || process.argv[2] === '--continue') {
  // the default task plants four bugs; a working workflow should surface most of them
  const planted = { 'average off-by-one': /<=\s*values\.length|off-by-one|越界|i <= /iu, 'clamp min/max swapped': /clamp/iu, 'capitalize charAt(1)': /charAt\(1\)|capitalize/iu, 'isBlank inverted': /isBlank/iu }
  const found = Object.entries(planted).filter(([, pattern]) => pattern.test(result.stdout)).map(([name]) => name)
  check('the answer reports the planted bugs (>= 3 of 4)', found.length >= 3, found.join(', '))
}

const journalPath = join(dshHome, 'state', 'dynamic-workflow', 'journal.sqlite')
check('journal created', existsSync(journalPath), journalPath)
if (existsSync(journalPath)) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(journalPath, { readOnly: true })
  const runs = db.prepare('select id, status, spent_tokens, failure_json, name from dwf_run order by time_created').all()
  const completed = runs.filter(run => run.status === 'completed')
  check('a workflow run completed', completed.length >= 1, runs.map(run => `${run.id.slice(0, 15)}… ${run.status} "${run.name ?? ''}"`).join('; '))
  const run = completed.at(-1) ?? runs.at(-1)
  if (run !== undefined) {
    const actorRows = db.prepare('select session_id from dwf_actor where run_id = ?').all(run.id)
    const actors = actorRows.length
    const asks = db.prepare("select count(*) as n from dwf_node where run_id = ? and kind = 'ask'").get(run.id).n
    check('the run used >= 2 subagents', actors >= 2, `${actors} actors, ${asks} asks`)
    const childLogs = [...walk(dshHome)].filter(path => actorRows.some(row => row.session_id !== null && path.includes(row.session_id)))
    check('every subagent transcript persisted as a DSH session', childLogs.length >= actorRows.filter(row => row.session_id !== null).length && childLogs.length > 0, `${childLogs.length} child session logs`)
    const descriptorCounts = childLogs.map(path => readLog(path).split('\n').filter(line => line.includes('"type":"subagent/descriptor"')).length)
    check('each subagent carries one subagent/descriptor (openable in the Web UI)', descriptorCounts.length > 0 && descriptorCounts.every(n => n === 1), descriptorCounts.join(','))
    check('tokens accounted', run.spent_tokens > 0, `${run.spent_tokens} tokens`)
    if (run.status !== 'completed' && run.failure_json) console.log(`   failure: ${String(run.failure_json).slice(0, 600)}`)
    const runEntry = join(workspace, '.dsh', 'workflow-runs', `${run.id}.mjs`)
    check('sandbox entry file under .dsh/workflow-runs', existsSync(runEntry))
  }
  db.close()
}
const drafts = join(workspace, '.dsh', 'workflow-drafts')
check('script draft saved', existsSync(drafts) && readdirSync(drafts).some(file => file.endsWith('.dwf.ts')))

// the session log: progress records must be ignorable plugin records; the skill and the notification must be there
function* walk(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')) yield path
  }
}
/** The main session (the one that called create_workflow), from its log path or contents. */
function mainSessionId() {
  const logs = [...walk(dshHome), ...walk(workspace)].filter(path => !/[/\\]dwf-dwfrun-/u.test(path))
  for (const path of logs) {
    let text
    try { text = readLog(path) } catch { continue } // a log cut off mid-frame by a killed Host
    if (!text.includes('create_workflow')) continue
    return /(session-[A-Za-z0-9_-]+)/u.exec(path)?.[1] ?? /"(session-[A-Za-z0-9_-]+)"/u.exec(text)?.[1]
  }
  return undefined
}

/** Session logs are zstd-compressed by default (DSH session-persistence-jsonl `compression`). */
function readLog(path) {
  const bytes = readFileSync(path)
  return path.endsWith('.zstd') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
}
const logs = [...walk(dshHome), ...walk(workspace)]
const mainLog = logs.filter(path => !/[/\\]dwf-dwfrun-/u.test(path)).map(path => ({ path, text: readLog(path) })).find(item => item.text.includes('create_workflow'))
check('main session log found', mainLog !== undefined, mainLog?.path ?? `${logs.length} jsonl files`)
if (mainLog !== undefined) {
  const lines = mainLog.text.split('\n').filter(Boolean)
  const records = lines.filter(line => line.includes('plugin:dynamic-workflow/progress'))
  check('progress persisted as plugin records', records.length > 5, `${records.length} records`)
  check('every progress record is ignorable', records.length > 0 && records.every(line => line.includes('"ignorable":true')))
  const events = lines.flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
  const calls = events.filter(event => event.type === 'tool/call').map(event => ({ seq: event.seq, name: event.data?.name, args: String(event.data?.arguments ?? '') }))
  const skillCall = calls.find(call => call.name === 'skill' && call.args.includes('dynamic-workflows'))
  const createCall = calls.find(call => call.name === 'create_workflow')
  check('skill loaded before create_workflow', skillCall !== undefined && createCall !== undefined && skillCall.seq < createCall.seq, calls.map(call => call.name).join(' → '))
  check('terminal <task-notification> delivered', mainLog.text.includes('task-notification'))
}

// reload: the session must reopen with the plugin records in it
const sessionId = mainLog === undefined ? undefined : /(session-[A-Za-z0-9_-]+)/u.exec(mainLog.path)?.[1] ?? /"(session-[A-Za-z0-9_-]+)"/u.exec(mainLog.text)?.[1]
if (sessionId !== undefined) {
  try {
    const out = execFileSync(dshBin, ['headless', '--patch', patchPath, '--session-id', sessionId, 'In one sentence: how many bugs did the workflow report?'], { cwd: workspace, env, encoding: 'utf8', timeout: 5 * 60_000 })
    check('session reloads (dsh headless --session-id)', out.trim().length > 0, out.trim().slice(0, 160))
  } catch (error) {
    check('session reloads (dsh headless --session-id)', false, String(error.stderr ?? error).slice(-600))
  }
}

const passed = checks.filter(c => c.ok).length
writeFileSync(join(temp, 'e2e-report.json'), JSON.stringify({ dshVersion, model, baseURL, bearer, seconds: Number(seconds), checks }, null, 2))
console.log(`\n${passed}/${checks.length} checks passed · artifacts in ${temp}`)
if (passed !== checks.length) fail(`${checks.length - passed} check(s) failed`)
else console.log('LIVE E2E OK')
if (process.env.DWF_E2E_KEEP !== '1' && passed === checks.length) rmSync(temp, { recursive: true, force: true })
else rmSync(patchPath, { force: true })
