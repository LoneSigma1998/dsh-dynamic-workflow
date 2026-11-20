/**
 * Vertical commit-graph spine for the right-sidebar run pane (ported from ZCode
 * `WorkflowRunPhaseList.tsx` + `WorkflowRunPhasePills.tsx`, Apache-2.0, styled with DSH tokens).
 *
 *   - Running phases and waiting holes auto-expand; completed & pending phases stay cleanly
 *     collapsed with a terminal/avatar cluster (`>_ [🟣✓] 2/2 ▸`).
 *   - Expanded phase pills are sleek single-line stadium pills (`32px`, `rounded-full`):
 *     `[AgentFace] 终审评审员                          2 个任务 ↗`
 *     Clicking a subagent pill opens its conversation; clicking `>_ Script` opens the script logbook.
 */

import { Fragment, memo, useCallback, useEffect, useMemo, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CreateWorkflowCausalityGraph } from '../display/types.ts'
import type { WorkflowRunPendingQuestion, WorkflowRunState } from '../shared/runs/workflow-runs.ts'
import { AgentFace, ScriptCheckIcon, TerminalGlyphIcon } from './AgentFace.tsx'
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
import { stepDot } from './run-view.ts'

export { SPINE_JOINT_PX, SPINE_TRACK_X, spineLayout, type SpineJoint, type SpineLayout, type SpineRailPiece, type SpineSection }

function questionKey(question: WorkflowRunPendingQuestion): string | undefined {
  return question.actorSiteId === undefined || question.actorOrdinal === undefined
    ? undefined
    : `${question.actorSiteId}@${question.actorOrdinal}`
}

/** Port of ZCode `pillActivity` (`timeline-pill-activity.ts`): counts asks & world-reads in this phase. */
function pillActivityCounts(graph: CreateWorkflowCausalityGraph | null | undefined, pill: TimelinePill): { asks: number; reads: number } {
  if (graph === undefined || graph === null) return { asks: 0, reads: 0 }
  const stepsById = new Map(graph.steps.map(s => [s.id, s]))
  let asks = 0
  let reads = 0
  for (const id of pill.stepIds) {
    const step = stepsById.get(id)
    if (step === undefined || step.kind === 'hole') continue
    if (step.kind === 'world-read') reads += 1
    else asks += 1
  }
  return { asks, reads }
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
  names: LaneNameFormatter
  t: Translate
  openChild: (sessionId: string) => void
  onOpenWorkspace?: ((phaseId?: string) => void) | undefined
}

export const RunSpine = memo(function RunSpine({ model, graph, run, names, t, openChild, onOpenWorkspace }: RunSpineProps) {
  const layout = useMemo(() => spineLayout(model), [model])
  const pendingQuestions = run?.pendingQuestions ?? []

  // ZCode parity (`WorkflowRunPhaseList.tsx` L108-118): auto-expand ONLY running stations & waiting holes!
  const activeKey = model.stations
    .filter(station => station.status === 'running' || station.hole?.state === 'waiting')
    .map(station => station.id)
    .join('\u0000')
  const activeIds = useMemo(() => (activeKey === '' ? [] : activeKey.split('\u0000')), [activeKey])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    if (activeIds.length > 0) return new Set(activeIds)
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
    const openActor = !isScript && session !== undefined
    const openScript = isScript && onOpenWorkspace !== undefined && pill.workspace !== undefined
    const openable = openActor || openScript
    const activity = pillActivityCounts(graph, pill)
    const counts: string[] = []
    if (!isScript && activity.asks > 0) counts.push(t('spine.tasks', { count: activity.asks }))
    if (activity.reads > 0) counts.push(t('spine.reads', { count: activity.reads }))

    // While actively running, show the subagent's current live tool subtly next to task count
    const liveTool = pill.status === 'running' && pill.instance !== undefined
      ? (run?.nodes ?? []).find(n => n.actorSiteId === pill.instance!.siteId && n.actorOrdinal === pill.instance!.ordinal && n.phase !== 'settled')?.lastTool?.name
      : undefined
    if (liveTool !== undefined) counts.push(liveTool)

    const instanceKey = pillInstanceKey(pill)
    const questions = instanceKey === undefined ? [] : (questionsByInstance.get(instanceKey) ?? [])

    const rowBody = (
      <>
        {isScript
          ? <TerminalGlyphIcon size={15} />
          : (
            <AgentFace
              avatarIndex={pill.avatarIndex}
              name={name}
              status={pill.status}
              showCompletionMark={pill.status === 'done'}
              size={18}
            />
          )}
        <span className="dwf-pill-name" title={name}>{name}</span>
        {counts.length > 0 ? <span className="dwf-spine-pill-trailer">{counts.join(' · ')}</span> : null}
        {pill.asking === true ? <span className="dwf-pill-asking" aria-hidden>?</span> : null}
        <span className="dwf-pill-tail">
          {isScript && pill.status === 'done' ? <ScriptCheckIcon done /> : null}
          {pill.status === 'running' ? <StateDot state="ongoing" size={10} /> : null}
          {pill.status === 'failed' ? <StateDot state="error" size={10} /> : null}
          {openable ? <span className="dwf-pill-open-arrow" aria-hidden>↗</span> : null}
        </span>
      </>
    )
    return (
      <div key={pill.key} className="dwf-spine-pill-wrap">
        {openable ? (
          <button
            type="button"
            className="dwf-spine-pill dwf-pill-button"
            data-status={pill.status ?? 'static'}
            onClick={() => {
              if (openScript) onOpenWorkspace!(pill.workspace?.phaseId)
              else openChild(session!)
            }}
            aria-label={openScript ? t('pill.openScript') : t('pill.open', { name })}
          >
            {rowBody}
          </button>
        ) : (
          <div className="dwf-spine-pill" data-status={pill.status ?? 'static'}>{rowBody}</div>
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

        return (
          <Fragment key={station.id}>
            {section.fork !== undefined ? <SpineJointRow joint={section.fork} kind="fork" pitch={layout.pitch} gutter={layout.gutter} /> : null}
            <section className="dwf-spine-section" data-phase-id={station.id} data-status={station.status ?? 'static'}>
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
                            return <TerminalGlyphIcon key={pill.key} size={14} className="dwf-terminal-icon-sm" />
                          }
                          const pName = pill.runtimeName ?? laneDisplayName(pill.lane, names)
                          return (
                            <AgentFace
                              key={pill.key}
                              avatarIndex={pill.avatarIndex}
                              name={pName}
                              status={pill.status}
                              showCompletionMark={pill.status === 'done'}
                              size={16}
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
                              return <AgentFace key={pill.key} avatarIndex={pill.avatarIndex} name={pName} status={pill.status} size={15} className="dwf-deck-face" />
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
