#!/usr/bin/env node
/**
 * LIVE Web check: boots the real `dsh web` (plugin installed in the web profile), drives the real
 * browser UI with Playwright against the real model, and screenshots each surface of the plugin:
 * the streaming draft card, the confirmation card in the composer seat, the running and completed
 * timeline card, the notice chip and the run pane.
 *
 * Usage: node tests/e2e/web-live.mjs <work dir with home/ + ws/ + patch.json> <screenshot dir> [phase]
 *   env: DSH_BIN, DWF_E2E_API_KEY, PLAYWRIGHT_FROM (dir with node_modules/playwright)
 *   phase: `explore` (boot + screenshot + aria dump) or `run` (full flow, default)
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const [workDir, shotDir, phase = 'run'] = process.argv.slice(2).map((value, index) => (index < 2 ? resolve(value) : value))
mkdirSync(shotDir, { recursive: true })
const { chromium } = createRequire(join(resolve(process.env.PLAYWRIGHT_FROM ?? '.'), 'noop.js'))('playwright')
const log = (...args) => console.log(`[web ${new Date().toISOString().slice(11, 19)}]`, ...args)

const dsh = spawn(process.env.DSH_BIN ?? 'dsh', ['web', '--patch', join(workDir, 'patch.json'), '--no-open', '--port', '0', '--host', '127.0.0.1'], {
  cwd: join(workDir, 'ws'),
  env: { ...process.env, DSH_HOME: join(workDir, 'home'), NO_COLOR: '1' },
})
let serverLog = ''
const url = await new Promise((resolveUrl, reject) => {
  const timer = setTimeout(() => reject(new Error(`no URL within 90 s:\n${serverLog.slice(-2000)}`)), 90_000)
  const onData = (chunk) => {
    serverLog += chunk
    const match = /(https?:\/\/127\.0\.0\.1:\d+\/\S*)/u.exec(serverLog)
    if (match !== null) { clearTimeout(timer); resolveUrl(match[1]) }
  }
  dsh.stdout.on('data', onData)
  dsh.stderr.on('data', onData)
  dsh.on('exit', code => reject(new Error(`dsh web exited ${code}:\n${serverLog.slice(-2000)}`)))
})
log('dsh web at', url.replace(/token=[^&\s]+/u, 'token=…'))

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, locale: 'zh-CN' })
const page = await context.newPage()
const consoleLines = []
page.on('console', message => consoleLines.push(`${message.type()}: ${message.text()}`))
page.on('pageerror', error => consoleLines.push(`pageerror: ${error.message}`))
const pluginRequests = []
page.on('response', async (response) => {
  if (!response.url().includes('dynamic-workflow/api/') || response.request().method() !== 'POST') return
  const body = await response.text().catch(() => '')
  log(`POST ${response.url().replace(/^https?:\/\/[^/]+\//u, '')} → ${response.status()} ${body.slice(0, 300)}`)
})
page.on('response', (response) => { if (/\/plugins\//u.test(response.url())) pluginRequests.push(`${response.status()} ${decodeURIComponent(response.url().replace(/^https?:\/\/[^/]+/u, '')).slice(0, 160)}`) })
let shot = 0
const snap = async (name, locator) => {
  const file = join(shotDir, `${String(++shot).padStart(2, '0')}-${name}.png`)
  if (locator !== undefined) {
    // the chat list is virtualized: bring the element in first, and fall back to the viewport
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 })
      await locator.screenshot({ path: file, timeout: 10_000, animations: 'disabled' })
    } catch (error) {
      log(`element screenshot of ${name} failed (${String(error).split('\n')[0].slice(0, 80)}); viewport instead`)
      await page.screenshot({ path: file })
    }
  } else await page.screenshot({ path: file })
  log('screenshot', file)
}

/** Wait for the run to settle, screenshotting the run node every 30 s; returns whether it settled. */
async function watchProgress(node, settled, remaining) {
  for (;;) {
    const left = remaining()
    const ok = await settled.waitFor({ timeout: Math.min(30_000, left) }).then(() => true, () => false)
    if (ok) return true
    if (left <= 30_000) { log('run not settled within the budget'); return false }
    const meta = await node.locator('.dwf-card-meta').first().textContent().catch(() => '')
    log('progress:', meta)
    await snap('progress', node)
  }
}

try {
  await page.goto(url)
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined)
  await page.waitForTimeout(3000)
  // first-run notice
  const proceed = page.getByRole('dialog').getByRole('button', { name: /继续|Continue/u })
  if (await proceed.count() > 0) await proceed.first().click()
  await page.waitForTimeout(1500)
  const ours = pluginRequests.filter(line => line.includes('dsh-dynamic-workflow'))
  log(`plugin bundle requests: ${pluginRequests.length}; ours: ${ours.join(' | ') || '(none)'}`)
  const graph = await page.evaluate(() => JSON.stringify(globalThis.__DSH_BOOT__ ?? null))
  writeFileSync(join(shotDir, 'boot-graph.json'), graph)
  log(`boot graph mentions us: ${graph.includes('dsh-dynamic-workflow')}; requests:\n  ${pluginRequests.map(line => line.slice(0, 120)).join('\n  ')}`)
  await snap('home')
  const styleInfo = async () => page.evaluate(() => {
    const owners = [...document.querySelectorAll('style[data-plugin]')].map(node => `${node.getAttribute('data-plugin')}:${node.getAttribute('data-path')}`)
    let dwfRule = false
    for (const sheet of [...document.styleSheets]) { try { for (const rule of [...sheet.cssRules]) if (String(rule.cssText).includes('.dwf-card')) dwfRule = true } catch { /* cross-origin */ } }
    return { count: owners.length, ours: owners.filter(o => o.includes('dynamic')), dwfRule, sample: owners.slice(0, 4) }
  })
  if (phase === 'explore') {
    log('styles:', JSON.stringify(await styleInfo()))
    writeFileSync(join(shotDir, 'aria.txt'), await page.locator('body').ariaSnapshot())
    log('aria snapshot written')
  } else if (phase === 'continue') {
    // after a Host restart mid-run: the run node must say it was interrupted (not "running"), and
    // its 续跑 button must resume it from the journal (finished subagents replayed from cache)
    const deadline = Date.now() + Number(process.env.DWF_WEB_BUDGET_MS ?? 150_000)
    const remaining = () => Math.max(5_000, deadline - Date.now())
    const sessions = page.getByRole('treeitem').filter({ hasNotText: /^(新会话|New session|默认工作区|Default workspace)/u })
    await (process.env.DWF_WEB_SESSION === undefined ? sessions.first() : page.getByRole('treeitem', { name: new RegExp(process.env.DWF_WEB_SESSION, 'u') }).last()).click()
    const node = page.locator('[data-dwf-run]').last()
    await node.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(2500)
    log('status after restart:', await node.getAttribute('data-run-status'), '|', await node.locator('.dwf-card-status').first().textContent())
    await snap('interrupted', node)
    const resume = node.getByRole('button', { name: /续跑|Resume/u })
    if (await resume.count() === 0) throw new Error('no resume button on the interrupted run')
    await resume.click()
    await page.locator('[data-dwf-run][data-run-status="running"]').last().waitFor({ timeout: 60_000 })
    log('resumed:', await node.locator('.dwf-card-meta').first().textContent())
    const target = Number(process.env.DWF_WEB_RETUNE ?? 0)
    if (target > 0) {
      // raise the run's concurrency from the run pane's control
      await node.getByRole('button', { name: /打开详情|Open details/u }).click()
      const pane = page.locator('.dwf-pane').last()
      await pane.waitFor({ timeout: 10_000 })
      for (let i = 0; i < 8; i += 1) {
        const text = await pane.locator('.dwf-retune').first().textContent().catch(() => '')
        const value = Number(/(\d+)/u.exec(text ?? '')?.[1] ?? 0)
        if (value >= target) break
        await pane.getByRole('button', { name: /提高并发|Raise concurrency/u }).click()
        await page.waitForTimeout(1500)
      }
      log('retuned:', await pane.locator('.dwf-retune').first().textContent().catch(() => '?'))
      await snap('retuned-pane', pane)
    }
    await page.waitForTimeout(4000)
    await snap('resumed', node)
    const settled = page.locator('[data-dwf-run][data-run-status="completed"], [data-dwf-run][data-run-status="errored"], [data-dwf-run][data-run-status="stopped"]').last()
    const done = await watchProgress(node, settled, remaining)
    await snap(done ? 'settled' : 'segment-end', node)
    if (done) {
      await page.waitForTimeout(Math.min(25_000, Math.max(0, deadline - Date.now())))
      await snap('page-after')
    }
    log('final status:', await node.getAttribute('data-run-status'))
  } else if (phase === 'probe') {
    // the artifact route in the real Host: the header is required, previews are inert, downloads are attachments
    const runId = process.env.DWF_WEB_RUN
    const result = await page.evaluate(async (run) => {
      const base = 'dynamic-workflow/api'
      const detail = await (await fetch(`${base}/runs/${encodeURIComponent(run)}`, { headers: { 'x-dynamic-workflow-request': '1' } })).json()
      const artifact = detail.snapshot.artifacts[0]
      const url = `${base}/artifacts/${encodeURIComponent(run)}/${encodeURIComponent(artifact.id)}/v${artifact.version}`
      const bare = await fetch(url)
      const inline = await fetch(`${url}?inline=1`, { headers: { 'x-dynamic-workflow-request': '1' } })
      const download = await fetch(url, { headers: { 'x-dynamic-workflow-request': '1' } })
      const blob = await download.blob()
      return {
        artifact: artifact.id,
        bare: bare.status,
        inline: { status: inline.status, type: inline.headers.get('content-type'), csp: inline.headers.get('content-security-policy'), disposition: inline.headers.get('content-disposition') },
        download: { status: download.status, type: download.headers.get('content-type'), disposition: download.headers.get('content-disposition'), bytes: blob.size },
      }
    }, runId)
    log('artifact route:', JSON.stringify(result))
  } else if (phase === 'confirm') {
    // the confirmation card with editable settings; the launch is denied (no run, few tokens)
    const input = page.getByRole('textbox').last()
    await input.click()
    await input.fill(process.env.DWF_WEB_PROMPT ?? '用工作流审查 src/journal 下每个文件，每个文件一个子代理找明确的 bug，最后汇总。只读。')
    await page.keyboard.press('Enter')
    const confirm = page.locator('[data-dwf-confirm]')
    await confirm.waitFor({ timeout: 160_000 })
    await page.waitForTimeout(1500)
    await snap('confirm-settings', confirm)
    const plus = confirm.locator('[data-dwf-settings] .dwf-step').nth(1)
    await plus.click()
    await plus.click()
    await page.waitForTimeout(400)
    await snap('confirm-settings-changed', confirm)
    log('settings changed to:', await confirm.locator('[data-dwf-setting="concurrency"]').textContent(), 'was-marker:', await confirm.locator('.dwf-setting-was').count())
    await confirm.getByRole('button', { name: /^(拒绝|Deny)$/u }).click()
    await page.waitForTimeout(3000)
  } else if (phase === 'review') {
    // after a Host restart: reopen the newest session; the run node must come back from the
    // persisted progress records / projection, without the run being live
    await page.getByRole('treeitem').filter({ hasNotText: /^(新会话|New session|默认工作区|Default workspace)/u }).first().click()
    const node = page.locator('[data-dwf-run]').last()
    await node.waitFor({ timeout: 60_000 })
    await page.waitForTimeout(2500)
    await snap('restored-run-node', node)
    log('restored run status:', await node.getAttribute('data-run-status'))
    await node.getByRole('button', { name: /打开详情|Open details/u }).click()
    await page.waitForTimeout(2500)
    const pane = page.locator('.dwf-pane').last()
    if (await pane.count() > 0) await snap('restored-run-pane', pane)
    await snap('restored-page')
    // the pane's lower sections (artifacts preview, script steps, changes) and the list view
    if (await pane.count() > 0) {
      for (const section of ['[data-dwf-artifacts]', '[data-dwf-steps]', '[data-dwf-changes]']) {
        const el = pane.locator(section).first()
        if (await el.count() > 0) { await el.scrollIntoViewIfNeeded().catch(() => undefined); await page.waitForTimeout(800); await snap(`pane-${section.replace(/\W+/gu, '')}`, el) }
        else log('pane section absent:', section)
      }
      const probe = await page.evaluate(async () => {
        const link = document.querySelector('[data-dwf-artifact]')
        if (link === null) return null
        const runId = document.querySelector('[data-dwf-run]')?.getAttribute('data-dwf-run')
        return runId
      })
      log('artifact probe run:', probe)
      // the download button saves the artifact as a file (fetched with the header, Blob URL)
      const downloadButton = pane.locator('[data-dwf-download]').first()
      if (await downloadButton.count() > 0) {
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), downloadButton.click()])
        const saved = await download.path()
        const { statSync } = await import('node:fs')
        log('artifact download:', download.suggestedFilename(), saved === null ? 'no file' : `${statSync(saved).size} bytes`)
      }
      await pane.locator('.dwf-pane-head .dwf-link').first().click().catch(() => undefined)
      await page.waitForTimeout(2000)
      const home = page.locator('.dwf-pane').last()
      await snap('pane-list-routing-saved', home)
      log('routing control:', await page.locator('[data-dwf-routing]').count(), 'saved list:', await page.locator('[data-dwf-saved-list]').count())
    }
    // a subagent pill opens that subagent's transcript
    const pill = node.locator('button.dwf-pill-button').nth(1)
    if (await pill.count() > 0) {
      log('opening subagent:', await pill.getAttribute('aria-label'))
      await pill.click()
      await page.waitForTimeout(4000)
      await snap('subagent-transcript')
    } else log('no openable pill in the restored node')
  } else {
    const deadline = Date.now() + Number(process.env.DWF_WEB_BUDGET_MS ?? 165_000)
    const remaining = () => Math.max(5_000, deadline - Date.now())
    // a fresh session in the workspace, then the task
    const input = page.getByRole('textbox').last()
    await input.click()
    await input.fill(process.env.DWF_WEB_PROMPT ?? '用工作流审查 src/ 下每个 .ts 文件：每个文件一个独立子代理找出明确的 bug（行号+原因），最后一个子代理汇总成按严重程度排序的清单。不需要额外复核，只读。')
    await page.keyboard.press('Enter')
    log('prompt sent; waiting for the workflow card to stream')
    const card = page.locator('[data-dwf-card="create_workflow"]').last()
    await card.waitFor({ timeout: remaining() })
    await page.waitForTimeout(1500)
    await snap('card-streaming', card)
    log('waiting for the confirmation card')
    const confirm = page.locator('[data-dwf-confirm]')
    await confirm.waitFor({ timeout: remaining() })
    await page.waitForTimeout(1200)
    log('styles at confirm:', JSON.stringify(await styleInfo()))
    await snap('confirm-card', confirm)
    await snap('confirm-page')
    await confirm.getByRole('button', { name: /^(运行|Run)$/u }).click()
    log('confirmed; waiting for the run node')
    const node = page.locator('[data-dwf-run]').last()
    await node.waitFor({ timeout: remaining() })
    await page.waitForTimeout(6000)
    await snap('run-node-running', node)
    await snap('page-running')
    const settled = page.locator('[data-dwf-run][data-run-status="completed"], [data-dwf-run][data-run-status="errored"], [data-dwf-run][data-run-status="stopped"]').last()
    await watchProgress(node, settled, remaining)
    await page.waitForTimeout(2000)
    await snap('run-node-settled', node)
    await snap('card-after', card)
    const notice = page.locator('.dwf-notice').last()
    if (await notice.count() > 0) await snap('notice', notice)
    await node.getByRole('button', { name: /打开详情|Open details/u }).click()
    await page.waitForTimeout(2500)
    const pane = page.locator('.dwf-pane').last()
    if (await pane.count() > 0) await snap('run-pane', pane)
    await snap('page-final')
    log('final status:', await node.getAttribute('data-run-status'))
    // let the main agent finish its answer before the Host stops
    await page.waitForTimeout(Math.min(15_000, Math.max(0, deadline - Date.now())))
  }
} catch (error) {
  log('ERROR', error instanceof Error ? error.message.split('\n')[0] : String(error))
  await snap('error').catch(() => undefined)
  process.exitCode = 1
} finally {
  writeFileSync(join(shotDir, 'console.txt'), consoleLines.join('\n'))
  writeFileSync(join(shotDir, 'server.txt'), serverLog.replace(/token=[^&\s]+/gu, 'token=…'))
  const problems = consoleLines.filter(line => /error|warning: web boot|dynamic-workflow|dsh-dynamic/iu.test(line))
  log(`console: ${consoleLines.length} lines; relevant:\n  ${problems.slice(0, 15).join('\n  ') || '(none)'}`)
  await browser.close()
  dsh.kill('SIGTERM')
}
