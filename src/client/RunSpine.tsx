/**
 * Vertical commit-graph spine for the right-sidebar run pane (ported from ZCode
 * `WorkflowRunPhaseList.tsx` + `workflowRunSpine.ts`, Apache-2.0, styled with DSH tokens).
 *
 *   - Running phases and waiting holes auto-expand; settled/pending phases collapse cleanly into a
 *     single row with stacked `AgentFace` tiles (`showCompletionMark`) and step fraction (`2/2 ▸`).
 *   - Per-phase pill stats (`toolCalls`, `tokens`, `lastTool`) match the pill's own `stepIds`
 *     (`graph.steps[].siteIds`) so multi-turn subagents never leak stats across phases.
 */

import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateWorkflowCausalityGraph } from '../display/types.ts'
import type { WorkflowRunPendingQuestion, WorkflowRunState } from '../shared/runs/workflow-runs.ts'
import { AgentFace, ScriptCheckIcon } from './AgentFace.tsx'
import type { Translate } from './host-types.ts'
import { laneDisplayName, type LaneNameFormatter } from './model/graph/lane-name.ts'
import { phaseDisplayName } from './model/graph/phase-name.ts'
import {
  pillInstanceKey,
  ROSTER_DECK,
  ROSTER_PINS_PANE,
  rosterMore,
  rosterRoll,
  stationRosterOf,
} from './model/timeline/roster-model.ts'
import type { TimelinePill, TimelineStation, WorkflowTimelineModel } from './model/timeline/timeline-model.ts'
import { SPINE_JOINT_PX, SPINE_TRACK_X, spineLayout, type SpineJoint, type SpineLayout, type SpineRailPiece, type SpineSection } from './model/timeline/spine-layout.ts'
import { formatExactTokens, stepDot } from './run-view.ts'

export { SPINE_JOINT_PX, SPINE_TRACK_X, spineLayout, type SpineJoint, type SpineLayout, type SpineRailPiece, type SpineSection }

export interface JournalAskNode {
  siteId: string
  ordinal: number
  kind: string
  status: string
  actorSiteId?: string
  actorOrdinal?: number
  actorSeq?: number
  stats?: { tokens?: number; toolCalls?: number; turns?: number }
}

function questionKey(question: WorkflowRunPendingQuestion): string | undefined {
  return question.actorSiteId === undefined || question.actorOrdinal === undefined
    ? undefined
    : `${question.actorSiteId}@${question.actorOrdinal}`
}

function SpineJointRow({ joint, kind, pitch, gutter }: { joint: SpineJoint; kind: 'fork' | 'merge'; pitch: number; gutter: number }) {
  const width = SPINE_TRACK_X + gutter + 10
  const x0 = SPINE_TRACK_X
  const h = SPINE_JOINT_PX
  const mainPath = joint.open === true
    ? kind === 'fork' ? `M${x0},4 V${h}` : `M${x0},0 V${h - 4}`
    : `M${x0},0 V${h}`
  return (
    <div className="dwf-spine-joint" style={{ height: h }} aria-hidden>
      <svg width={width} height={h} viewBox={`0 0 ${width} ${h}`}>
        <path d={mainPath} fill="none" className={`dwf-ink dwf-ink-${joint.main}`} />
        {joint.open === true ? <circle cx={x0} cy={kind === 'fork' ? 4 : h - 4} r={2} className={`dwf-ink-fill-${joint.main === 'march' ? 'strong' : joint.main}`} /> : null}
        {joint.branches.map((branch) => {
          const xt = x0 + pitch * branch.track
          const d = kind === 'fork'
            ? `M${x0},4 C${x0},${h - 4} ${xt},4 ${xt},${h}`
            : `M${xt},0 C${xt},${h - 4} ${x0},4 ${x0},${h - 4}`
          return <path key={branch.track} d={d} fill="none" className={`dwf-ink dwf-ink-${branch.ink}`} />
        })}
      </svg>
    </div>
  )
}

function lampClass(station: TimelineStation): string {
  const status = station.status ?? 'static'
  return `dwf-lamp dwf-spine-lamp dwf-lamp-${status}${station.hole === undefined ? '' : ' dwf-lamp-hole'}`
}

export interface RunSpineProps {
  model: WorkflowTimelineModel
  graph?: CreateWorkflowCausalityGraph | null | undefined
  run: WorkflowRunState | undefined
  askNodes?: readonly JournalAskNode[] | undefined
  names: LaneNameFormatter
  t: Translate
  openChild: (sessionId: string) => void
  changedBySession?: ReadonlyMap<string, number>
}

export const RunSpine = memo(function RunSpine({ model, graph, run, askNodes, names, t, openChild, changedBySession }: RunSpineProps) {
  const layout = useMemo(() => spineLayout(model), [model])
  const pendingQuestions = run?.pendingQuestions ?? []

  // ZCode parity: auto-expand ONLY running stations & waiting holes; completed stations stay neatly
  // collapsed with stacked avatar clusters so Artifacts & Result remain visible without scrolling.
  const activeKey = model.stations
    .filter(station => station.status === 'running' || station.hole?.state === 'waiting')
    .map(station => station.id)
    .join('\u0000')
  const activeIds = useMemo(() => (activeKey === '' ? [] : activeKey.split('\u0000')), [activeKey])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    if (activeIds.length > 0) return new Set(activeIds)
    // Single-station run: expand the one station since collapsing a 1-row list saves nothing.
    return model.stations.length === 1 ? new Set([model.stations[0]!.id]) : new Set()
  })
  useEffect(() => {
    if (activeIds.length === 0) return
    setOpen(prev => (activeIds.every(id => prev.has(id)) ? prev : new Set([...prev, ...activeIds])))
  }, [activeIds])
  const toggleOpen = useCallback((id: string) => {
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const [listed, setListed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleListed = useCallback((id: string) => {
    setListed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // Map graph stepId -> runtime call siteId (`step.source ?? step.id`) so each phase's pill resolves ONLY its own ask/world nodes.
  const stepSites = useMemo(() => {
    const map = new Map<string, string>()
    for (const step of graph?.steps ?? []) {
      map.set(step.id, step.source ?? step.id)
    }
    return map
  }, [graph])

  const questionsByInstance = useMemo(() => {
    const map = new Map<string, WorkflowRunPendingQuestion[]>()
    for (const q of pendingQuestions) {
      const key = questionKey(q)
      if (key === undefined) continue
      map.set(key, [...map.get(key) ?? [], q])
    }
    return map
  }, [pendingQuestions])

  const renderPillRow = (pill: TimelinePill) => {
    const name = pill.runtimeName ?? laneDisplayName(pill.lane, names)
    const session = pill.instance?.sessionId
    const isScript = pill.laneClass === 'workspace'
    const ownSites = new Set(pill.stepIds.map(sid => stepSites.get(sid) ?? sid))

    // Live projection node for THIS phase's ask site(s)
    const liveMatching = (run?.nodes ?? []).filter(n =>
      pill.instance !== undefined
      && n.actorSiteId === pill.instance.siteId
      && n.actorOrdinal === pill.instance.ordinal
      && (ownSites.size === 0 || ownSites.has(n.siteId)),
    )
    const liveNode = liveMatching.find(n => n.phase !== 'settled') ?? liveMatching.at(-1)

    // Durable journal ask node(s) for THIS phase's ask site(s) (carries exact per-ask tokens + toolCalls)
    const journalMatching = (askNodes ?? []).filter(n =>
      pill.instance !== undefined
      && n.actorSiteId === pill.instance.siteId
      && n.actorOrdinal === pill.instance.ordinal
      && ownSites.has(n.siteId),
    )
    const totalToolCalls = journalMatching.length > 0
      ? journalMatching.reduce((sum, n) => sum + (n.stats?.toolCalls ?? 0), 0)
      : (liveNode?.toolCalls ?? 0)
    const totalTokens = journalMatching.reduce((sum, n) => sum + (n.stats?.tokens ?? 0), 0)

    const changed = session === undefined ? 0 : (changedBySession?.get(session) ?? 0)
    const instanceKey = pillInstanceKey(pill)
    const questions = instanceKey === undefined ? [] : (questionsByInstance.get(instanceKey) ?? [])
    const unreached = run !== undefined && run.status !== 'running' && run.status !== 'pending' && (pill.status === undefined || pill.status === 'pending')

    const rowBody = (
      <>
        {isScript
          ? <span className="dwf-script-glyph" aria-hidden>&gt;_</span>
          : (
            <AgentFace
              avatarIndex={pill.avatarIndex}
              name={name}
              status={pill.status}
              showCompletionMark={pill.status === 'done'}
              size={22}
            />
          )}
        <span className="dwf-spine-pill-main">
          <span className="dwf-pill-name" title={name}>{name}</span>
          <span className="dwf-spine-pill-meta">
            {totalToolCalls > 0 ? <span>{t('pane.toolCalls', { count: totalToolCalls })}</span> : null}
            {totalTokens > 0 ? <span>{t('card.tokens', { tokens: formatExactTokens(totalTokens) })}</span> : null}
            {liveNode?.phase !== 'settled' && liveNode?.lastTool !== undefined ? <span>{t('pane.lastTool', { tool: liveNode.lastTool.name })}</span> : null}
            {liveNode?.cached === true ? <span>{t('pane.cached')}</span> : null}
            {changed > 0 ? <span className="dwf-change-badge">{t('changes.count', { count: changed })}</span> : null}
          </span>
        </span>
        {pill.asking === true ? <span className="dwf-pill-asking" aria-hidden>?</span> : null}
        {isScript ? <ScriptCheckIcon done={pill.status === 'done'} /> : null}
        {pill.status === 'running' ? <StateDot state="ongoing" size={10} /> : null}
        {pill.status === 'failed' ? <StateDot state="error" size={10} /> : null}
        {session !== undefined && pill.status === 'done' ? <span className="dwf-pill-open-arrow" aria-hidden>↗</span> : null}
      </>
    )
    return (
      <div key={pill.key} className="dwf-spine-pill-wrap">
        {session !== undefined ? (
          <button
            type="button"
            className="dwf-spine-pill dwf-pill-button"
            data-status={pill.status ?? 'static'}
            data-unreached={unreached ? '' : undefined}
            onClick={() => openChild(session)}
            aria-label={t('pill.open', { name })}
          >
            {rowBody}
          </button>
        ) : (
          <div className="dwf-spine-pill" data-status={pill.status ?? 'static'} data-unreached={unreached ? '' : undefined}>{rowBody}</div>
        )}
        {questions.map(q => (
          <div key={q.qid} className="dwf-spine-question">
            <span className="dwf-pill-asking" aria-hidden>?</span>
            <span>{q.question}</span>
          </div>
        ))}
      </div>
    )
  }

  const railColWidth = SPINE_TRACK_X + layout.gutter + 12
  const settledRun = run !== undefined && run.status !== 'running' && run.status !== 'pending'

  return (
    <div className="dwf-spine" data-dwf-spine="">
      {model.stations.map((station, index) => {
        const section = layout.sections[index]!
        const isOpen = open.has(station.id)
        const isListed = listed.has(station.id)
        const roster = stationRosterOf(station, ROSTER_PINS_PANE)
        const more = roster === undefined ? undefined : rosterMore(roster)
        const hasDoor = more !== undefined && more.count > 0
        const pinnedPills = roster === undefined ? station.pills : roster.pinned
        const roll = hasDoor && isListed && roster !== undefined ? rosterRoll(roster) : undefined
        const name = phaseDisplayName(station.naming, names)
        const lampLeft = SPINE_TRACK_X + layout.pitch * station.track - 5
        const unreachedStation = settledRun && !station.visited

        return (
          <Fragment key={station.id}>
            {section.fork !== undefined ? <SpineJointRow joint={section.fork} kind="fork" pitch={layout.pitch} gutter={layout.gutter} /> : null}
            <section className="dwf-spine-section" data-phase-id={station.id} data-status={station.status ?? 'static'} data-unreached={unreachedStation ? '' : undefined}>
              <div className="dwf-spine-rails" style={{ width: railColWidth }} aria-hidden>
                {section.rails.map((piece, rIdx) => {
                  const x = SPINE_TRACK_X + layout.pitch * piece.track
                  const cls = `dwf-spine-rail dwf-spine-rail-${piece.position} dwf-spine-ink-${piece.ink}${piece.stream === true ? ' dwf-spine-stream' : ''}`
                  return <span key={`${piece.track}:${piece.position}:${rIdx}`} className={cls} style={{ left: x }} />
                })}
                <span className={lampClass(station)} style={{ left: lampLeft }} />
              </div>
              <div className="dwf-spine-body" style={{ paddingLeft: railColWidth }}>
                <button
                  type="button"
                  className="dwf-spine-head"
                  aria-expanded={isOpen}
                  onClick={() => toggleOpen(station.id)}
                >
                  <span className="dwf-spine-name" title={name}>{name}</span>
                  {station.rounds > 1 && station.onLoop ? <span className="dwf-station-meta">⟳ {station.rounds}</span> : null}
                  {station.hole !== undefined ? (
                    <span className="dwf-station-meta dwf-hole-type">{station.hole.state === 'waiting' ? '…' : '✓'}</span>
                  ) : null}
                  <span className="dwf-spine-right">
                    {!isOpen && station.pills.length > 0 ? (
                      <span className="dwf-spine-cluster">
                        {station.pills.slice(0, ROSTER_DECK).map((pill) => {
                          if (pill.laneClass === 'workspace') {
                            return <span key={pill.key} className="dwf-script-glyph dwf-script-glyph-sm" aria-hidden>&gt;_</span>
                          }
                          const pName = pill.runtimeName ?? laneDisplayName(pill.lane, names)
                          return (
                            <AgentFace
                              key={pill.key}
                              avatarIndex={pill.avatarIndex}
                              name={pName}
                              status={pill.status}
                              showCompletionMark={pill.status === 'done'}
                              size={18}
                              className="dwf-cluster-face"
                            />
                          )
                        })}
                        {station.pills.length + (station.unlisted?.actors ?? 0) > ROSTER_DECK ? (
                          <span className="dwf-station-meta">+{station.pills.length + (station.unlisted?.actors ?? 0) - ROSTER_DECK}</span>
                        ) : null}
                      </span>
                    ) : null}
                    {station.fraction !== undefined && station.fraction.observed >= 1 ? (
                      <span className="dwf-station-meta">{station.fraction.settled}/{station.fraction.observed}</span>
                    ) : null}
                    <span className="dwf-spine-chevron" data-open={isOpen ? '' : undefined} aria-hidden>▸</span>
                  </span>
                </button>
                {isOpen ? (
                  <div className="dwf-spine-content">
                    {station.hole?.state === 'waiting' ? (
                      <p className="dwf-attention dwf-spine-hole">
                        {t('card.hole', { name })}{station.hole.prompt === undefined ? '' : ` · ${station.hole.prompt}`}
                      </p>
                    ) : null}
                    {pinnedPills.map(renderPillRow)}
                    {hasDoor ? (
                      <>
                        <button
                          type="button"
                          className="dwf-spine-pill dwf-pill-more dwf-pill-button"
                          aria-expanded={isListed}
                          onClick={() => toggleListed(station.id)}
                        >
                          <span className="dwf-deck">
                            {more.deck.map((pill) => {
                              const pName = pill.runtimeName ?? laneDisplayName(pill.lane, names)
                              return <AgentFace key={pill.key} avatarIndex={pill.avatarIndex} name={pName} status={pill.status} size={16} className="dwf-deck-face" />
                            })}
                          </span>
                          <span className="dwf-pill-name">{isListed ? t('spine.hideRest', { count: more.count }) : t('pill.more', { count: more.count })}</span>
                          {more.failed > 0 ? <span className="dwf-pill-failed">{t('pill.moreFailed', { count: more.failed })}</span> : null}
                        </button>
                        {roll !== undefined && roster !== undefined ? (
                          <div className="dwf-spine-roll" data-dwf-roll="">
                            {roll.map(group => (
                              <div key={group.status} className="dwf-spine-roll-group">
                                <div className="dwf-spine-roll-label">
                                  <StateDot state={stepDot(group.status)} size={8} />
                                  <span>{t(`spine.group.${group.status}`, { count: group.pills.length })}</span>
                                </div>
                                {group.pills.map(renderPillRow)}
                              </div>
                            ))}
                            {roster.unlisted.actors > 0 ? (
                              <p className="dwf-muted dwf-spine-unlisted">{t('spine.unlisted', { count: roster.unlisted.actors })}</p>
                            ) : null}
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>
            {section.merge !== undefined ? <SpineJointRow joint={section.merge} kind="merge" pitch={layout.pitch} gutter={layout.gutter} /> : null}
          </Fragment>
        )
      })}
    </div>
  )
})
