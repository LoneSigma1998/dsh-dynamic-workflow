/**
 * Same-origin HTTP routes under `/dynamic-workflow/api/` for the plugin's Web
 * client: run detail (journal reads too large for the session projection),
 * the launch awaiting confirmation, user actions on a run card (stop / resume /
 * retune), and artifact bytes.
 *
 * The route is `auth: 'required'` (DSH's Connection authenticates the browser
 * cookie and fences Host/Origin); mutating calls additionally require the owner
 * principal and every call carries `x-dynamic-workflow-request: 1` (a custom
 * header a cross-site form cannot send). Browser code fetches the
 * document-relative `dynamic-workflow/api/...`.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ArtifactStore } from '../service/artifacts.ts'
import type { RunService } from '../service/run-service.ts'
import type { LaunchConfirmation } from '../tools/confirm.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveOwnerAgent } from '../dsh/owner.ts'
import { compileOnce, type CompiledScript } from '../service/compile.ts'
import { findSaved, listSavedAll, resolveSavedArgs } from '../tools/sources.ts'
import { analyzeWorkflowScript } from '@zcode/dynamic-workflow'
import { displayOf } from '../tools/tools.ts'

/** Causality graphs of run scripts (pure function of the script text), bounded LRU. */
const graphCache = new Map<string, unknown>()
function graphOfScript(script: string): unknown {
  const hit = graphCache.get(script)
  if (hit !== undefined) return hit
  let graph: unknown = null
  try {
    graph = displayOf('get_workflow_run', analyzeWorkflowScript(script)).causalityGraph ?? null
  } catch {
    graph = null
  }
  graphCache.set(script, graph)
  if (graphCache.size > 32) graphCache.delete(graphCache.keys().next().value!)
  return graph
}

const PREFIX = '/dynamic-workflow'
const API = `${PREFIX}/api/`

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}

function sameOrigin(req: IncomingMessage): boolean {
  if (req.headers['x-dynamic-workflow-request'] !== '1') return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`
}

async function readBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Buffer)
    size += bytes.length
    if (size > maxBytes) throw new Error(`Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

interface Peer { principal?: { kind?: string } }

/**
 * Response headers of one artifact version. A preview (`inline`) is only ever an inert type: any
 * text — HTML, SVG and scripts included — as text/plain, raster images as themselves, all under a
 * sandboxing CSP; an artifact is never rendered as a document in the Host's origin (ZCode never
 * renders HTML artifacts in its renderer either). Everything else downloads with its file name.
 */
export function artifactResponseHeaders(id: string, meta: { contentType?: string; kind?: string } | undefined, inline: boolean, size: number): Record<string, string> {
  const type = meta?.contentType ?? (meta?.kind === 'markdown' ? 'text/markdown' : 'application/octet-stream')
  const raster = /^image\/(png|jpeg|gif|webp)$/u.test(type)
  const textual = type.startsWith('text/') || type === 'application/json' || type === 'image/svg+xml'
  const preview = inline && (raster || textual)
  const fileName = `${id}${meta?.kind === 'markdown' && !/\.md$/iu.test(id) ? '.md' : ''}`
  return {
    'content-type': !preview ? 'application/octet-stream' : raster ? type : 'text/plain; charset=utf-8',
    'content-disposition': preview ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'content-security-policy': "sandbox; default-src 'none'",
    'content-length': String(size),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
}

/** `provider/model` ids of every registered provider route (bounded). */
async function listModelIds(ctx: Context): Promise<{ id: string; name: string }[]> {
  const llm = ctx.get('llm' as never) as { listProviders?(): { id: string; name: string }[]; listModels?(provider: string): Promise<{ id: string; name?: string }[]> } | undefined
  if (llm?.listProviders === undefined || llm.listModels === undefined) return []
  const out: { id: string; name: string }[] = []
  for (const provider of llm.listProviders()) {
    try {
      for (const model of await llm.listModels(provider.id)) {
        out.push({ id: `${provider.id}/${model.id}`, name: model.name ?? model.id })
        if (out.length >= 200) return out
      }
    } catch {
      // a provider that cannot list its models is skipped
    }
  }
  return out
}

interface AccessLike {
  enabled: boolean
  mode: string
  activate(agent: Agent): void
  routingOf(agent: Agent | undefined): string
  setRouting(agent: Agent, routing: 'explicit' | 'suggest' | 'auto'): void
}

export function registerWorkflowRoutes(ctx: Context, deps: { service: RunService; artifacts: ArtifactStore; confirmation?: LaunchConfirmation; access?: AccessLike }): void {
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer') as { register(route: unknown): () => void }
    scope.effect(() => webServer.register({
      kind: 'prefix',
      path: PREFIX,
      auth: 'required',
      handler: async (req: IncomingMessage, res: ServerResponse, peer?: Peer) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith(API)) {
          res.writeHead(404)
          res.end()
          return
        }
        if (!sameOrigin(req)) {
          json(res, 403, { error: 'Same-origin request with x-dynamic-workflow-request: 1 required' })
          return
        }
        // Authentication. Newer Hosts enforce `auth: 'required'` themselves and pass the Peer;
        // DSH 0.2.2-rc.4 ignores route auth, so ask its Connection to admit the request
        // (Host/Origin fence + the signed browser cookie or an API credential).
        const connection = ctx.get('connection') as { admit?: (request: IncomingMessage) => { peer: Peer } | { rejection: number } } | undefined
        let caller = peer
        if (caller === undefined && connection?.admit !== undefined) {
          const admission = connection.admit(req)
          if ('rejection' in admission) {
            json(res, admission.rejection, { error: admission.rejection === 401 ? 'dsh web authentication required' : 'forbidden' })
            return
          }
          caller = admission.peer
        }
        const method = req.method ?? 'GET'
        if (method === 'POST' && caller === undefined) {
          json(res, 401, { error: 'An authenticated owner is required to control workflow runs.' })
          return
        }
        let segments: string[]
        try {
          segments = url.pathname.slice(API.length).split('/').map(decodeURIComponent)
        } catch {
          json(res, 400, { error: 'Malformed path encoding' })
          return
        }
        try {
          // GET runs/:runId — full snapshot (journal reads)
          if (method === 'GET' && segments[0] === 'runs' && segments.length === 2) {
            const runId = segments[1]!
            if (deps.service.journal.getRun(runId) === undefined && deps.service.liveRun(runId) === undefined) {
              json(res, 404, { error: `No run ${runId}` })
              return
            }
            const snapshot = deps.service.snapshot(runId)
            const row = deps.service.journal.getRun(runId)
            const script = deps.service.liveRun(runId)?.scriptText ?? row?.scriptText ?? null
            json(res, 200, { snapshot, script, graph: script === null ? null : graphOfScript(script), parentSessionId: row?.parentSessionId ?? null })
            return
          }
          // GET runs/:runId/nodes — the script-steps lane and per-task results
          if (method === 'GET' && segments[0] === 'runs' && segments[2] === 'nodes') {
            const runId = segments[1]!
            const nodes = deps.service.journal.listNodes(runId, { kinds: ['ask', 'world-read', 'world-run', 'artifact'], withResult: url.searchParams.get('results') === '1' })
            json(res, 200, { nodes })
            return
          }
          // GET runs/:runId/artifacts — full user-facing artifact list (content + preset dashboards with spec & itemCount)
          // GET runs/:runId/artifacts/:id/data?after=N&limit=200&fields=a,b — paged tagged report items for a dashboard preset
          if (method === 'GET' && segments[0] === 'runs' && segments[2] === 'artifacts') {
            const runId = segments[1]!
            if (segments.length === 3) {
              json(res, 200, { artifacts: deps.service.artifacts(runId) })
              return
            }
            if (segments.length === 5 && segments[4] === 'data') {
              const artifactId = segments[3]!
              const afterParam = url.searchParams.get('after')
              const limitParam = url.searchParams.get('limit')
              const fieldsParam = url.searchParams.get('fields')
              const after = afterParam === null ? undefined : Number(afterParam)
              const limit = limitParam === null ? undefined : Number(limitParam)
              const fields = fieldsParam === null || fieldsParam.trim() === '' ? undefined : fieldsParam.split(',').map(s => s.trim()).filter(Boolean)
              const page = deps.service.artifactData(runId, artifactId, {
                ...after !== undefined && Number.isFinite(after) && after >= 0 ? { afterSequence: after } : {},
                ...limit !== undefined && Number.isFinite(limit) && limit >= 1 ? { limit } : {},
                ...fields !== undefined && fields.length > 0 ? { fields } : {},
              })
              json(res, 200, page)
              return
            }
          }
          // GET runs/:runId/events?after=N — the raw journal event log (paged)
          if (method === 'GET' && segments[0] === 'runs' && segments[2] === 'events') {
            const runId = segments[1]!
            const after = Number(url.searchParams.get('after') ?? '-1')
            const events = deps.service.journal.listEvents(runId, { types: 'all', reportItems: { limit: 200 }, ...Number.isFinite(after) && after >= 0 ? { afterSequence: after } : {}, limit: 500 })
            json(res, 200, { events })
            return
          }
          // GET sessions/:sessionId/pending-launch — the launch awaiting the user's confirmation
          if (method === 'GET' && segments[0] === 'sessions' && segments[2] === 'pending-launch') {
            json(res, 200, { pending: deps.confirmation?.pendingFor(segments[1]!) ?? null })
            return
          }
          // GET runs/:runId/changes — what each subagent changed (file tools), with line counts
          // GET runs/:runId/changes/diff?session=…&path=… — one subagent's diff of one file
          if (method === 'GET' && segments[0] === 'runs' && segments[2] === 'changes') {
            const runId = segments[1]!
            if (segments[3] === 'diff') {
              const session = url.searchParams.get('session') ?? ''
              const path = url.searchParams.get('path') ?? ''
              const diff = deps.service.changeDiff(runId, session, path)
              if (diff === undefined) json(res, 404, { error: 'No such change' })
              else json(res, 200, diff)
              return
            }
            json(res, 200, { changes: deps.service.changes(runId) })
            return
          }
          // GET models — the model ids a run's subagents can be put on (confirmation card, Configure)
          if (method === 'GET' && segments[0] === 'models' && segments.length === 1) {
            json(res, 200, { models: await listModelIds(ctx) })
            return
          }
          // GET sessions/:sessionId/settings — the session's workflow mode and routing
          if (method === 'GET' && segments[0] === 'sessions' && segments[2] === 'settings' && segments.length === 3) {
            const agent = await resolveOwnerAgent(ctx, segments[1]!)
            json(res, 200, { mode: deps.access?.mode ?? 'alwaysOn', routing: deps.access?.routingOf(agent) ?? 'explicit' })
            return
          }
          // GET sessions/:sessionId/saved — the saved workflows this session's workspace sees, with their run history
          if (method === 'GET' && segments[0] === 'sessions' && segments[2] === 'saved' && segments.length === 3) {
            const agent = await resolveOwnerAgent(ctx, segments[1]!)
            const cwd = agent?.session.header.cwd
            if (cwd === undefined) {
              json(res, 200, { saved: [], available: false })
              return
            }
            const history = deps.service.journal.listRunRows(undefined, 200)
            const saved = listSavedAll(cwd).map(item => ({
              name: item.name, description: item.description, scope: item.scope,
              ...item.whenToUse === undefined ? {} : { whenToUse: item.whenToUse },
              ...item.args === undefined ? {} : { args: item.args },
              runs: history.filter(row => row.name === item.name).slice(0, 5).map(row => ({ runId: row.runId, status: row.status, ...row.stopReason === undefined ? {} : { stopReason: row.stopReason }, updated: row.updated, spentTokens: row.spentTokens, mine: row.parentSessionId === segments[1] })),
            }))
            json(res, 200, { saved, available: true, canRun: deps.access?.enabled !== false })
            return
          }
          // GET sessions/:sessionId/runs — run list of one session
          if (method === 'GET' && segments[0] === 'sessions' && segments[2] === 'runs') {
            json(res, 200, { runs: deps.service.listRuns(segments[1], 50) })
            return
          }
          // POST sessions/:sessionId/routing — this session's routing (explicit | suggest | auto)
          // POST sessions/:sessionId/saved/run — run a saved workflow from the GUI (ZCode's hub
          //   「运行」: the click is the consent; no model turn, no confirmation)
          if (method === 'POST' && segments[0] === 'sessions' && (segments[2] === 'routing' || (segments[2] === 'saved' && segments[3] === 'run'))) {
            if (caller?.principal?.kind !== 'owner') {
              json(res, 403, { ok: false, message: 'Only the owner can change workflows.' })
              return
            }
            const agent = await resolveOwnerAgent(ctx, segments[1]!)
            if (agent === undefined) {
              json(res, 409, { ok: false, message: 'That session is not available.' })
              return
            }
            const body = await readBody(req)
            if (segments[2] === 'routing') {
              const routing = body.routing
              if (routing !== 'explicit' && routing !== 'suggest' && routing !== 'auto') {
                json(res, 400, { ok: false, message: 'routing must be explicit, suggest or auto' })
                return
              }
              deps.access?.setRouting(agent, routing)
              json(res, 200, { ok: true, routing })
              return
            }
            if (deps.access?.enabled === false) {
              json(res, 409, { ok: false, message: 'Dynamic workflows are disabled in this deployment.' })
              return
            }
            const cwd = agent.session.header.cwd ?? process.cwd()
            const found = typeof body.name === 'string' ? findSaved(cwd, body.name, body.scope === 'project' || body.scope === 'global' ? body.scope : undefined) : undefined
            if (found === undefined) {
              json(res, 404, { ok: false, message: `No saved workflow named ${JSON.stringify(body.name)}.` })
              return
            }
            const resolved = resolveSavedArgs(found, typeof body.args === 'object' && body.args !== null ? body.args as Record<string, unknown> : undefined)
            if (!resolved.ok) {
              json(res, 400, { ok: false, message: resolved.message })
              return
            }
            let compiled: CompiledScript
            try {
              compiled = compileOnce(found.script)
            } catch (error) {
              json(res, 422, { ok: false, message: `The saved workflow no longer compiles: ${String(error).slice(0, 400)}` })
              return
            }
            deps.access?.activate(agent)
            json(res, 200, deps.service.submit({ scriptText: found.script, name: found.name, parent: agent, maxConcurrency: deps.service.defaultConcurrency(), compiled, args: resolved.args, scriptPath: found.path }))
            return
          }
          // POST runs/:runId/stop | resume | retune
          if (method === 'POST' && segments[0] === 'runs' && segments.length === 3) {
            if (caller?.principal?.kind !== 'owner') {
              json(res, 403, { ok: false, message: 'Only the owner can control workflow runs.' })
              return
            }
            const runId = segments[1]!
            const action = segments[2]
            if (action === 'stop') {
              json(res, 200, deps.service.cancel(runId, 'user'))
              return
            }
            if (action === 'retune') {
              const body = await readBody(req)
              const value = body.maxConcurrency
              if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 1)) {
                json(res, 400, { ok: false, message: 'maxConcurrency must be a positive finite number or null.' })
                return
              }
              json(res, 200, deps.service.retune(runId, value))
              return
            }
            if (action === 'configure') {
              // ZCode's Configure popover: a GUI revision of the run's settings, no model turn and
              // no confirmation (the click is the consent). Concurrency alone on a live run retunes
              // it in place; anything else starts a revision that imports the finished work.
              const body = await readBody(req)
              const max = typeof body.maxConcurrency === 'number' && Number.isInteger(body.maxConcurrency) && body.maxConcurrency >= 1 ? body.maxConcurrency : undefined
              const model = body.subagentModel === null ? null : typeof body.subagentModel === 'string' && /^[^/\s]+\/\S+$/u.test(body.subagentModel) ? body.subagentModel : undefined
              const row = deps.service.journal.getRun(runId)
              if (row === undefined) {
                json(res, 404, { ok: false, message: `No workflow run ${runId}.` })
                return
              }
              if (model === undefined && max !== undefined && deps.service.liveRun(runId) !== undefined) {
                json(res, 200, deps.service.retune(runId, max))
                return
              }
              if (deps.access?.enabled === false) {
                json(res, 409, { ok: false, message: 'Dynamic workflows are disabled in this deployment.' })
                return
              }
              const parent = row.parentSessionId === undefined ? undefined : await resolveOwnerAgent(ctx, row.parentSessionId)
              if (parent === undefined || row.scriptText === undefined) {
                json(res, 409, { ok: false, message: 'The session that owns this run is not available.' })
                return
              }
              deps.access?.activate(parent)
              json(res, 200, await deps.service.configure(runId, parent, { ...max === undefined ? {} : { maxConcurrency: max }, ...model === undefined ? {} : { subagentModel: model } }))
              return
            }
            if (action === 'resume') {
              if (deps.access?.enabled === false) {
                json(res, 409, { ok: false, message: 'Dynamic workflows are disabled in this deployment; existing runs can be viewed but not resumed.' })
                return
              }
              const row = deps.service.journal.getRun(runId)
              // After a Host restart the owner session is not loaded: load it (its agent receives
              // the run's notifications, so the conversation continues when the run settles).
              const parent = row?.parentSessionId === undefined ? undefined : await resolveOwnerAgent(ctx, row.parentSessionId)
              if (parent === undefined) {
                json(res, 409, { ok: false, message: 'The session that owns this run is not available.' })
                return
              }
              deps.access?.activate(parent)
              json(res, 200, await deps.service.resume(runId, parent))
              return
            }
          }
          // GET artifacts/:runId/:id/:version — artifact bytes
          if (method === 'GET' && segments[0] === 'artifacts' && segments.length === 4) {
            const [, runId, id, version] = segments as [string, string, string, string]
            const versionNumber = Number(version.replace(/^v/, ''))
            let path: string
            try {
              path = deps.artifacts.pathOf(runId, id, versionNumber)
            } catch {
              json(res, 400, { error: 'Invalid artifact address' })
              return
            }
            const info = await stat(path).catch(() => undefined)
            if (info === undefined || !info.isFile()) {
              json(res, 404, { error: 'No such artifact version' })
              return
            }
            const stream = createReadStream(path)
            // A read failure must end this response, never surface as an unhandled 'error' event.
            stream.on('error', () => { if (!res.headersSent) json(res, 500, { error: 'Artifact read failed' }); else res.destroy() })
            // `?inline=1` (the pane's preview): served with its own type when it is text or an image;
            // otherwise a download with a file name, so a desktop shell saves it instead of opening a window.
            // A preview (`?inline=1`) is only ever served as an inert type: any text — HTML, SVG and
            // scripts included — as text/plain, raster images as themselves, under a sandboxing
            // CSP. An artifact is never rendered as a document in the Host's origin (ZCode, too,
            // never renders HTML artifacts in its renderer). Everything else is a download.
            const headers = artifactResponseHeaders(id, deps.service.artifactMeta(runId, id, versionNumber), url.searchParams.get('inline') === '1', info.size)
            stream.once('open', () => {
              res.writeHead(200, headers)
              stream.pipe(res)
            })
            return
          }
          json(res, 404, { error: 'Unknown operation' })
        } catch (error) {
          json(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }))
  })
}
