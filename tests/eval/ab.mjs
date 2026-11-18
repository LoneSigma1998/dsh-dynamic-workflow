#!/usr/bin/env node
/**
 * A/B experiment: the same model on the same seeded review task, without and with a workflow.
 *
 *   node tests/eval/ab.mjs start <plain|workflow> <dir>   new trial (one time-boxed segment)
 *   node tests/eval/ab.mjs continue <dir>                 reopen the session (--session-id) and let it finish
 *   node tests/eval/ab.mjs score <dir...>                 score trials against the ground truth
 *
 * Every model request goes through a local counting proxy in front of the gateway, so tokens
 * are exact for both arms (main agent and every subagent). Wall time is the sum of the segments.
 * Config: .env (DWF_E2E_BASE_URL, DWF_E2E_API_KEY, DWF_E2E_MODEL), DSH_BIN, DWF_SEGMENT_MS.
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { BUGS, DECOYS, FILES, PROMPT_BODY } from './repo.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const env = { ...process.env }
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/u)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/u.exec(line)
    if (match !== null && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^["']|["']$/gu, '')
  }
}
const upstream = (env.DWF_E2E_BASE_URL ?? env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/u, '')
const apiKey = env.DWF_E2E_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN
const model = env.DWF_E2E_MODEL ?? 'workbuddy/deepseek-v4.1-flash[1m]'
const dshBin = env.DSH_BIN ?? 'dsh'
const segmentMs = Number(env.DWF_SEGMENT_MS ?? 160_000)
const log = (...args) => console.log('[ab]', ...args)

/** A counting proxy: forwards to the gateway, appends each response's usage to usage.jsonl. */
function startProxy(usageFile) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const headers = { ...req.headers }
    delete headers.host
    delete headers['content-length']
    let response
    try {
      response = await fetch(`${upstream}${req.url}`, { method: req.method, headers, body: chunks.length === 0 ? undefined : Buffer.concat(chunks) })
    } catch (error) {
      res.writeHead(502).end(String(error))
      return
    }
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key))))
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let text = ''
    for await (const chunk of response.body ?? []) {
      res.write(chunk)
      text += Buffer.from(chunk).toString('utf8')
      // scan complete lines for usage objects (SSE message_start / message_delta, or a JSON body)
      const lines = text.split('\n')
      text = lines.pop() ?? ''
      for (const line of lines) scan(line, usage)
    }
    scan(text, usage)
    res.end()
    appendFileSync(usageFile, `${JSON.stringify({ at: Date.now(), status: response.status, ...usage })}\n`)
  })
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => resolvePromise(server)))
}

function scan(line, usage) {
  const at = line.indexOf('"usage"')
  if (at < 0) return
  const json = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
  try {
    const value = JSON.parse(json)
    const found = value.usage ?? value.message?.usage
    if (found === undefined) return
    usage.input = Math.max(usage.input, found.input_tokens ?? 0)
    usage.output = Math.max(usage.output, found.output_tokens ?? 0)
    usage.cacheRead = Math.max(usage.cacheRead, found.cache_read_input_tokens ?? 0)
    usage.cacheWrite = Math.max(usage.cacheWrite, found.cache_creation_input_tokens ?? 0)
  } catch { /* partial line */ }
}

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : name.startsWith('session.v4.jsonl') ? [path] : []
  })
}

function readLog(path) {
  try {
    const bytes = readFileSync(path)
    return path.endsWith('.zstd') ? zstdDecompressSync(bytes).toString('utf8') : bytes.toString('utf8')
  } catch {
    return ''
  }
}

function mainSessionId(dir) {
  for (const path of walk(join(dir, 'home', 'sessions'))) {
    if (/[/\\]dwf-dwfrun-/u.test(path)) continue
    const id = /(session-[A-Za-z0-9_-]+)/u.exec(path)?.[1]
    if (id !== undefined) return id
  }
  return undefined
}

async function segment(dir, args) {
  const state = JSON.parse(readFileSync(join(dir, 'trial.json'), 'utf8'))
  const proxy = await startProxy(join(dir, 'usage.jsonl'))
  const port = proxy.address().port
  const patch = [
    { id: 'llm-pi-ai', config: { providers: { 'ab-gw': { api: 'anthropic-messages', apiKeyEnv: 'DWF_E2E_API_KEY', baseURL: `http://127.0.0.1:${port}`, models: [{ id: model, maxTokens: 16384 }] } } } },
    { id: 'agent-default-model', config: { provider: 'ab-gw', model } },
    ...state.arm === 'workflow'
      ? [{ insert: [{ id: 'dynamic-workflow', name: join(root, 'lib', 'index.js'), config: { confirm: 'never', holdTurnWhileRunning: true } }] }]
      : [],
  ]
  writeFileSync(join(dir, 'patch.json'), JSON.stringify(patch, null, 2))
  const started = Date.now()
  const result = await new Promise((resolvePromise) => {
    const child = spawn(dshBin, ['headless', '--patch', join(dir, 'patch.json'), ...args], {
      cwd: join(dir, 'ws'),
      env: { ...env, DSH_HOME: join(dir, 'home'), DWF_E2E_API_KEY: apiKey, NO_COLOR: '1', NODE_USE_ENV_PROXY: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), segmentMs)
    child.on('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal, stdout, stderr }) })
  })
  proxy.close()
  const seconds = (Date.now() - started) / 1000
  state.segments.push({ args: args.slice(0, -1), seconds, code: result.code, signal: result.signal })
  // the time box ends dsh with SIGTERM, which it may answer with exit 0: a cut is a cut
  const cut = result.signal !== null || seconds * 1000 >= segmentMs - 1500
  if (result.code === 0 && !cut) state.answer = result.stdout
  state.done = result.code === 0 && !cut
  writeFileSync(join(dir, `stdout-${state.segments.length}.txt`), result.stdout)
  writeFileSync(join(dir, `stderr-${state.segments.length}.txt`), result.stderr.slice(-20_000))
  writeFileSync(join(dir, 'trial.json'), JSON.stringify(state, null, 2))
  log(`${state.arm}: segment ${state.segments.length} ${state.done ? 'finished' : `cut at ${seconds.toFixed(0)}s (${result.signal ?? result.code})`}`)
}

function findings(answer) {
  const blocks = [...answer.matchAll(/```json\s*([\s\S]*?)```/gu)]
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(blocks[i][1])
      if (Array.isArray(value)) return value.filter(item => item !== null && typeof item === 'object')
    } catch { /* try the previous block */ }
  }
  return undefined
}

function score(dir) {
  const state = JSON.parse(readFileSync(join(dir, 'trial.json'), 'utf8'))
  const usage = existsSync(join(dir, 'usage.jsonl'))
    ? readFileSync(join(dir, 'usage.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const tokens = usage.reduce((sum, u) => ({ input: sum.input + u.input + u.cacheRead + u.cacheWrite, output: sum.output + u.output, cacheRead: sum.cacheRead + u.cacheRead, requests: sum.requests + 1 }), { input: 0, output: 0, cacheRead: 0, requests: 0 })
  const listed = state.answer === undefined ? undefined : findings(state.answer)
  const norm = path => String(path ?? '').replace(/^\.?\/*/u, '').replace(/^.*?(src\/)/u, '$1')
  const near = (item, target) => norm(item.file) === target.file && Math.abs(Number(item.line) - target.line) <= 3
  const found = BUGS.filter(bug => listed?.some(item => near(item, bug)))
  const decoyHits = DECOYS.filter(decoy => listed?.some(item => near(item, decoy)))
  const other = (listed ?? []).filter(item => !BUGS.some(bug => near(item, bug)) && !DECOYS.some(decoy => near(item, decoy)))
  return {
    dir, arm: state.arm, done: state.done === true,
    seconds: Math.round(state.segments.reduce((sum, s) => sum + s.seconds, 0)), segments: state.segments.length,
    listed: listed?.length ?? null, recall: `${found.length}/${BUGS.length}`, decoys: `${decoyHits.length}/${DECOYS.length}`, unmatched: other.length,
    tokens, missed: BUGS.filter(bug => !found.includes(bug)).map(bug => bug.id), decoyIds: decoyHits.map(d => d.id), otherItems: other.map(item => `${norm(item.file)}:${item.line} ${String(item.bug ?? '').slice(0, 80)}`),
  }
}

const [command, ...rest] = process.argv.slice(2)
if (command === 'start') {
  const [arm, dirArg] = rest
  if (arm !== 'plain' && arm !== 'workflow') throw new Error('arm must be plain or workflow')
  const dir = resolve(dirArg)
  mkdirSync(join(dir, 'ws'), { recursive: true })
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(dir, 'ws', path)), { recursive: true })
    writeFileSync(join(dir, 'ws', path), text)
  }
  writeFileSync(join(dir, 'trial.json'), JSON.stringify({ arm, segments: [] }, null, 2))
  const prompt = arm === 'workflow' ? `用工作流完成这个任务：${PROMPT_BODY}` : PROMPT_BODY
  await segment(dir, [prompt])
} else if (command === 'continue') {
  const dir = resolve(rest[0])
  const id = mainSessionId(dir)
  if (id === undefined) throw new Error('no main session found')
  await segment(dir, ['--session-id', id, '继续刚才的任务；如果工作流已经结束就直接汇总，最后按要求在末尾给出 ```json 清单。'])
} else if (command === 'score') {
  const rows = rest.map(dir => score(resolve(dir)))
  console.log(JSON.stringify(rows, null, 2))
} else {
  console.log('usage: ab.mjs start <plain|workflow> <dir> | continue <dir> | score <dir...>')
}
