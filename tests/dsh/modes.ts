/**
 * Mode and routing (ZCode parity) through the real DSH loop and command runtime:
 * - onDemand: a fresh session's requests carry no workflow tools and no routing section; after
 *   `/workflow …` they carry both, and the activation survives in the session log;
 * - routing: `/dwf routing suggest` swaps the section for the suggest rule (persisted), and the
 *   explicit rule is the default;
 * - disabled: no workflow tools, no `/workflow`, no section, ever.
 * Run: DWF_TEST_HOOK=1 tsx --tsconfig tsconfig.test.json tests/dsh/modes.ts
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { ScriptedModel, text } from './scripted-model.ts'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import FileSystem from '@deepseek-ai/dsh-fs-local'

const WorkflowPlugin = await import(process.env.DWF_PLUGIN === 'lib' ? '../../lib/index.js' : '../../src/index.ts')

function plug(context: Context, plugin: unknown, config: unknown = {}): Promise<unknown> {
  return (context.plugin as unknown as (plugin: unknown, config: unknown) => Promise<unknown>).call(context, plugin, config)
}

async function compose(config: object, skills = false): Promise<{ ctx: Context; model: ScriptedModel; create(id: string): Promise<Agent>; temp: string }> {
  const temp = mkdtempSync(join(tmpdir(), 'dwf-modes-'))
  const model = new ScriptedModel(async () => text('ok'))
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await plug(ctx, CommandRuntime)
  if (skills) {
    await plug(ctx, FileSystem)
    await plug(ctx, WorkingDirectory, { defaultDirectory: temp })
    await plug(ctx, SkillRegistry)
    await plug(ctx, ToolSkill)
  }
  ctx.llm.registerAdapter(['scripted'], model)
  await plug(ctx, WorkflowPlugin, { stateDir: join(temp, 'state'), confirm: 'never', skillGate: false, ...config })
  const loop = (ctx as unknown as { agentLoop: { create(id: SessionId, options: object, meta?: object): Promise<Agent> } }).agentLoop
  return { ctx, model, temp, create: id => loop.create(id as SessionId, { provider: 'scripted', model: 'm' }, { cwd: temp }) }
}

async function say(agent: Agent, value: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function command(ctx: Context, agent: Agent, line: string): Promise<{ kind: string; text?: string } | undefined> {
  const commands = (ctx as unknown as { commands: { execute(agent: Agent, line: string, attachments: never[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined> } }).commands
  const execution = await commands.execute(agent, line, [], new AbortController().signal)
  await agent.whenIdle()
  return execution?.result
}

const lastRequest = (model: ScriptedModel) => model.requests.at(-1)!

async function main(): Promise<void> {
  // ——— onDemand ———
  {
    const { ctx, model, create, temp } = await compose({ mode: 'onDemand' })
    const agent = await create('ondemand-session')
    await say(agent, 'hello')
    assert.ok(!lastRequest(model).tools.includes('create_workflow'), 'no workflow tools before activation')
    assert.ok(!lastRequest(model).system.includes('Dynamic workflows (create_workflow)'), 'no routing section before activation')
    const result = await command(ctx, agent, '/workflow review the src folder')
    assert.equal(result?.kind, 'success', JSON.stringify(result))
    assert.ok(lastRequest(model).tools.includes('create_workflow'), 'workflow tools after /workflow')
    assert.match(lastRequest(model).system, /run only when the user asks for one/u, 'explicit routing is the default')
    const settingsEvents = () => (agent.session.snapshotEvents() as readonly { type: string; data: unknown }[]).filter(e => e.type === 'plugin:dynamic-workflow/settings')
    const persisted = settingsEvents().some(e => (e.data as { activated?: boolean }).activated === true)
    assert.ok(persisted, 'activation is recorded in the session log')
    // routing switch, persisted
    const switched = await command(ctx, agent, '/dwf routing suggest')
    assert.match(switched?.text ?? '', /suggest/u)
    await say(agent, 'look at this repo')
    assert.match(lastRequest(model).system, /routing for this session: suggest/u, 'the suggest rule replaces the explicit one')
    assert.ok(settingsEvents().some(e => (e.data as { routing?: string }).routing === 'suggest'))
    // another session in the same Host is untouched
    const other = await create('ondemand-other')
    await say(other, 'hi')
    assert.ok(!lastRequest(model).tools.includes('create_workflow'), 'activation is per session')
    try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
    rmSync(temp, { recursive: true, force: true })
    console.log('✓ modes: onDemand hides the tools until /workflow; activation and routing are per session and persisted')
  }
  // ——— alwaysOn + auto routing by config ———
  {
    const { ctx, model, create, temp } = await compose({ routing: 'auto' })
    const agent = await create('auto-session')
    await say(agent, 'hello')
    assert.ok(lastRequest(model).tools.includes('create_workflow'), 'alwaysOn offers the tools from the first request')
    assert.match(lastRequest(model).system, /routing for this session: auto/u)
    assert.match(lastRequest(model).system, /overrides the `dynamic-workflows` skill's rule/u)
    try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
    rmSync(temp, { recursive: true, force: true })
    console.log('✓ modes: alwaysOn offers the tools at once; routing auto is the standing opt-in')
  }
  // ——— disabled ———
  {
    const { ctx, model, create, temp } = await compose({ mode: 'disabled' })
    const agent = await create('disabled-session')
    await say(agent, 'use a workflow to review this')
    assert.ok(!lastRequest(model).tools.some(name => name.endsWith('_workflow') || name.startsWith('list_workflow')), `no workflow tools: ${lastRequest(model).tools.join(', ')}`)
    const result = await command(ctx, agent, '/workflow review')
    assert.equal(result, undefined, '/workflow is not a command when disabled')
    try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
    rmSync(temp, { recursive: true, force: true })
    console.log('✓ modes: disabled offers no workflow tools and no /workflow')
  }
  // ——— /workflow loads the skill in the same request (DSH's own skill gesture) ———
  {
    const { ctx, model, create, temp } = await compose({}, true)
    const agent = await create('gesture-session')
    await command(ctx, agent, '/workflow review the src folder')
    const request = lastRequest(model)
    const texts = request.messages.filter(m => m.role === 'user').map(m => (Array.isArray(m.content) ? m.content : []).map(b => (b as { text?: string }).text ?? '').join(''))
    assert.ok(texts.some(t => t.startsWith('/dynamic-workflows ')), 'the /workflow prompt carries the skill gesture')
    assert.ok(texts.some(t => t.includes('<skill_content name="dynamic-workflows">')), 'tool-skill injected the skill body into the very first request')
    assert.equal(model.requests.filter(r => r.lastToolResult?.name === 'skill').length, 0, 'no round trip through the skill tool')
    try { ctx.registry.delete(WorkflowPlugin as never) } catch { /* disposed */ }
    rmSync(temp, { recursive: true, force: true })
    console.log('✓ modes: /workflow injects the dynamic-workflows skill in its first request (no skill-tool round trip)')
  }
  console.log('MODES OK')
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) })
