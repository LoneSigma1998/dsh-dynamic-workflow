/**
 * The horizontal workflow timeline (ZCode's design, DSH tokens): one rail, phases as stations on
 * it, subagents as pills hanging under their station, non-adjacent edges as arcs in the air above
 * the rail, parallel phases as bands of branch tracks. Geometry and the model are ZCode's
 * (`model/timeline/*`, ported verbatim); this file is only the renderer.
 *
 * Follows ZCode Invariant 3 (`WorkflowAgentPill.tsx`): unvisited/pending pills keep 100% crisp
 * surface & full-saturation `AgentFace` color with sleeping `dots` eyes and secondary label color
 * (never washed-out opacity). Native scrollbar is hidden in favor of ZCode's 2px track bar.
 */

import { memo, useEffect, useId, useMemo, useRef, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { AgentFace, ScriptCheckIcon, TerminalGlyphIcon } from './AgentFace.tsx'
import { laneDisplayName, type LaneNameFormatter } from './model/graph/lane-name.ts'
import { phaseDisplayName } from './model/graph/phase-name.ts'
import { pillStatusOf, rosterMore, stationRosterOf, ROSTER_DECK, ROSTER_PINS_CARD } from './model/timeline/roster-model.ts'
import {
  ARC_BASE,
  ARC_LANE,
  arcEnds,
  arcTerminalOffsets,
  bandAt,
  bandForkX,
  bandMergeX,
  CAPTION_X,
  lampX,
  MARK_X,
  PILL_GAP,
  PILL_HEIGHT,
  STATION_WIDTH,
  stationX,
  STUB,
  TAIL,
  timelineLayout,
  timelineWidth,
  type TimelineLayout,
} from './model/timeline/timeline-geometry.ts'
import type { TimelineBand, TimelineInk, TimelinePill, TimelineStation, WorkflowTimelineModel } from './model/timeline/timeline-model.ts'
import type { Translate } from './host-types.ts'

interface RailPiece { key: string; d: string; ink: TimelineInk; kind?: string }

/** Rail pieces as SVG paths (port of ZCode `timelineRailPieces`). */
function railPieces(model: Pick<WorkflowTimelineModel, 'bands' | 'rails' | 'stations'>, layout: TimelineLayout): RailPiece[] {
  const { bands, rails, stations } = model
  const { inset, rowY } = layout
  const y0 = rowY[0]!
  const rowOf = (track: number): number => rowY[track] ?? y0
  const lx = (i: number): number => lampX(i, inset)
  const trackOf = (i: number): number => stations[i]?.track ?? 0
  const straight = (x1: number, x2: number, y: number): string => `M${x1},${y} H${x2}`
  const forkPath = (band: TimelineBand, track: number, head: number): string => {
    const xf = bandForkX(band, inset) - 8 * (track - 1)
    const yt = rowOf(track)
    return `M${xf},${y0} Q${xf + 8},${y0} ${xf + 8},${y0 - 8} V${yt + 8} Q${xf + 8},${yt} ${xf + 16},${yt} H${lx(head) - 8}`
  }
  const mergePath = (band: TimelineBand, track: number, tail: number): string => {
    const xm = bandMergeX(band, inset) - 8 * (band.tracks.length - 1 - track)
    const yt = rowOf(track)
    return `M${lx(tail) + 8},${yt} H${xm - 8} Q${xm},${yt} ${xm},${yt + 8} V${y0 - 8} Q${xm},${y0} ${xm + 8},${y0}`
  }
  const pieces: RailPiece[] = []
  for (const band of bands) {
    const main = band.tracks[0]!
    if (band.pred === undefined) {
      const head = main.stations[0]!
      pieces.push({ key: `tail:${band.from}`, d: straight(bandForkX(band, inset) - TAIL, lx(head) - 8, y0), ink: main.entry })
      band.tracks.forEach((track, t) => {
        if (t > 0) pieces.push({ key: `fork:${band.from}:${t}`, d: forkPath(band, t, track.stations[0]!), ink: track.entry })
      })
    }
    if (band.join === undefined) {
      const last = main.stations[main.stations.length - 1]!
      pieces.push({ key: `stub:${band.to}`, d: straight(lx(last) + 8, bandMergeX(band, inset) + STUB, y0), ink: main.exit })
      band.tracks.forEach((track, t) => {
        if (t > 0) pieces.push({ key: `merge:${band.to}:${t}`, d: mergePath(band, t, track.stations[track.stations.length - 1]!), ink: track.exit })
      })
    }
  }
  for (const rail of rails) {
    if (rail.kind === 'twin') continue
    const key = `${rail.from}>${rail.to}`
    if (rail.kind === 'fork') {
      const band = bandAt(bands, rail.to)
      if (band !== undefined) pieces.push({ key, d: forkPath(band, trackOf(rail.to), rail.to), ink: rail.ink, kind: 'fork' })
      continue
    }
    if (rail.kind === 'merge') {
      const band = bandAt(bands, rail.from)
      if (band !== undefined) pieces.push({ key, d: mergePath(band, trackOf(rail.from), rail.from), ink: rail.ink, kind: 'merge' })
      continue
    }
    const source = bandAt(bands, rail.from)
    const target = bandAt(bands, rail.to)
    if (source !== undefined && target !== undefined && source !== target) {
      pieces.push({ key, d: straight(bandMergeX(source, inset), bandForkX(target, inset), y0), ink: rail.ink })
      continue
    }
    const yt = rowOf(trackOf(rail.from))
    pieces.push({ key, d: straight(lx(rail.from) + 8, lx(rail.to) - 8, yt), ink: rail.ink, ...rail.kind === undefined ? {} : { kind: rail.kind } })
  }
  return pieces
}

function arcPaths(model: WorkflowTimelineModel, layout: TimelineLayout): { key: string; d: string; ink: TimelineInk }[] {
  const { arcs, bands, stations } = model
  const terminals = arcTerminalOffsets(arcs, bands, stations)
  const { inset, rowY } = layout
  const rowOf = (track: number): number => rowY[track] ?? rowY[0]!
  const trackOf = (index: number): number => stations[index]?.track ?? 0
  return arcs.map((arc, j) => {
    const { fromBand, toBand } = arcEnds(arc, bands, stations)
    const source = bandAt(bands, arc.from)
    const target = bandAt(bands, arc.to)
    const ly = rowOf(arc.air) - ARC_BASE - ARC_LANE * arc.lane
    const xa = fromBand && source !== undefined ? bandMergeX(source, inset) : lampX(arc.from, inset) + terminals.takeoff[j]!
    const xb = toBand && target !== undefined ? bandForkX(target, inset) : lampX(arc.to, inset) + terminals.landing[j]!
    const sign = xb < xa ? -1 : 1
    const ya = fromBand ? rowY[0]! - 3 : rowOf(trackOf(arc.from)) - 7
    const yb = toBand ? rowY[0]! - 4 : rowOf(trackOf(arc.to)) - 9
    const d = `M${xa},${ya} V${ly + 8} Q${xa},${ly} ${xa + 8 * sign},${ly} H${xb - 8 * sign} Q${xb},${ly} ${xb},${ly + 8} V${yb}`
    return { key: `${arc.from}-${arc.to}-${arc.air}`, d, ink: arc.ink }
  })
}

export interface TimelineProps {
  model: WorkflowTimelineModel
  names: LaneNameFormatter
  t: Translate
  /** Open the transcript behind a subagent pill (live/settled runs). */
  onOpenPill?: ((pill: TimelinePill) => void) | undefined
  /** Open the script logbook for a `>_ Script` pill. */
  onOpenWorkspace?: ((pill: TimelinePill) => void) | undefined
  /** Highest number of pills drawn per station before the "n more" row. */
  pins?: number
  /** Show at most this many pill rows (the card); the pane passes Infinity. */
  maxPillRows?: number
}

function lampClass(station: TimelineStation): string {
  const status = station.status ?? 'static'
  return `dwf-lamp dwf-lamp-${status}${station.hole === undefined ? '' : ' dwf-lamp-hole'}${station.typing === true ? ' dwf-lamp-typing' : ''}`
}

export const Timeline = memo(function Timeline({ model, names, t, onOpenPill, onOpenWorkspace, pins = ROSTER_PINS_CARD, maxPillRows = 6 }: TimelineProps) {
  const markerId = useId().replace(/[^\w-]/g, '')
  const [scrollState, setScrollState] = useState<{ hasEnd: boolean; ratio: number; offset: number }>({ hasEnd: false, ratio: 1, offset: 0 })
  const layout = useMemo(() => timelineLayout(model.arcs, model.bands), [model])
  const geometry = useMemo(() => {
    const rails = railPieces(model, layout)
    const arcs = arcPaths(model, layout)
    const listed = model.stations.map(station => {
      const roster = stationRosterOf(station, pins)
      const more = roster === undefined ? undefined : rosterMore(roster)
      return { pills: roster === undefined ? station.pills : roster.pinned, more: more !== undefined && more.count > 0 ? more : undefined }
    })
    const rows = Math.min(maxPillRows, Math.max(0, ...listed.map(r => r.pills.length + (r.more === undefined ? 0 : 1))))
    const rosters = listed.map(({ pills, more }) => {
      const overflow = more !== undefined || pills.length > rows
      const visible = overflow ? pills.slice(0, Math.max(0, rows - 1)) : pills
      const hidden = pills.slice(visible.length)
      const row = !overflow ? undefined : {
        count: hidden.length + (more?.count ?? 0),
        deck: [...hidden, ...more?.deck ?? []].slice(0, ROSTER_DECK),
        failed: hidden.filter(pill => pillStatusOf(pill) === 'failed').length + (more?.failed ?? 0),
      }
      return { visible, more: row }
    })
    return { rails, arcs, rosters, rows }
  }, [model, layout, pins, maxPillRows])
  const scroller = useRef<HTMLDivElement>(null)
  const focus = useMemo(() => {
    for (let i = model.stations.length - 1; i >= 0; i -= 1) if (model.stations[i]!.status === 'running') return i
    return -1
  }, [model])
  useEffect(() => {
    const el = scroller.current
    if (el === null || focus < 0) return
    const left = stationX(focus, layout.inset)
    const right = left + STATION_WIDTH
    if (right > el.scrollLeft + el.clientWidth || left < el.scrollLeft) el.scrollTo({ left: Math.max(0, right - el.clientWidth + 12), behavior: 'smooth' })
  }, [focus, layout.inset])
  useEffect(() => {
    const el = scroller.current
    if (el === null) return
    const update = (): void => {
      const start = el.scrollLeft > 2
      const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 2
      const fade = start && end ? 'both' : start ? 'start' : end ? 'end' : ''
      if (el.dataset.fade !== fade) el.dataset.fade = fade
      const ratio = el.scrollWidth > 0 ? Math.min(1, el.clientWidth / el.scrollWidth) : 1
      const offset = el.scrollWidth > el.clientWidth ? el.scrollLeft / el.scrollWidth : 0
      setScrollState(prev => (prev.hasEnd === end && Math.abs(prev.ratio - ratio) < 0.005 && Math.abs(prev.offset - offset) < 0.005 ? prev : { hasEnd: end, ratio, offset }))
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update)
    observer?.observe(el)
    if (el.firstElementChild !== null) observer?.observe(el.firstElementChild)
    return () => { el.removeEventListener('scroll', update); observer?.disconnect() }
  }, [model.stations.length === 0])
  const count = model.stations.length
  if (count === 0) return null
  const width = timelineWidth(count, layout.inset, model.tailStub !== undefined)
  const height = layout.pillsTop + geometry.rows * (PILL_HEIGHT + PILL_GAP)
  const draft = model.draft !== undefined
  const anyDoneBeyond = model.stations.slice(-2).some(s => s.status === 'done')
  const showTrackBar = scrollState.ratio < 0.99
  return (
    <div className="dwf-timeline-wrap">
      <div className="dwf-timeline-scroll" ref={scroller}>
        <div className={`dwf-timeline${draft ? ' dwf-timeline-draft' : ''}`} style={{ width, height }}>
          <svg aria-hidden className="dwf-timeline-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            <defs>
              {(['faint', 'strong'] as const).map(ink => (
                <marker id={`${markerId}-${ink}`} key={ink} markerHeight="6" markerWidth="6" orient="auto-start-reverse" refX="7" refY="4" viewBox="0 0 8 8">
                  <path d="M0,0.5 L7,4 L0,7.5 Z" className={`dwf-ink-fill-${ink}`} />
                </marker>
              ))}
            </defs>
            {geometry.rails.map(piece => (
              <path key={piece.key} d={piece.d} fill="none" className={`dwf-ink dwf-ink-${piece.ink}${piece.kind === 'stream' ? ' dwf-ink-stream' : ''}`} />
            ))}
            {geometry.arcs.map(arc => (
              <path key={arc.key} d={arc.d} fill="none" className={`dwf-ink dwf-ink-${arc.ink} dwf-arc`} markerEnd={`url(#${markerId}-${arc.ink === 'march' ? 'strong' : arc.ink})`} />
            ))}
            {layout.banded && model.stations.map((station, i) => station.track === 0 ? null : (
              <path key={`leader:${station.id}`} d={`M${lampX(i, layout.inset)},${(layout.rowY[station.track] ?? layout.rowY[0]!) + 7} V${layout.capY - 10}`} className="dwf-leader" fill="none" />
            ))}
          </svg>
          {model.stations.map((station, i) => {
            const x = stationX(i, layout.inset)
            const lampY = layout.rowY[station.track] ?? layout.rowY[0]!
            const name = phaseDisplayName(station.naming, names)
            const captionY = layout.banded ? layout.capY : lampY
            const roster = geometry.rosters[i]!
            const visible = roster.visible
            return (
              <div key={station.id} className="dwf-station" data-status={station.status ?? 'static'} style={{ left: x, width: STATION_WIDTH }}>
                <span aria-hidden className={lampClass(station)} style={{ left: lampX(i, layout.inset) - x - 5, top: lampY - 5 }} />
                <div className="dwf-station-caption" style={{ top: captionY - 10, left: layout.banded ? CAPTION_X : MARK_X + 7 }} title={name}>
                  <span className="dwf-station-name">{name}</span>
                  {station.typing === true ? <span className="dwf-caret" aria-hidden /> : null}
                  {station.rounds > 1 && station.onLoop ? <span className="dwf-station-meta">⟳ {station.rounds}</span> : null}
                  {station.fraction !== undefined && station.fraction.observed >= 1 ? <span className="dwf-station-meta">{station.fraction.settled}/{station.fraction.observed}</span> : null}
                  {station.hole !== undefined ? <span className="dwf-station-meta dwf-hole-type">{station.hole.state === 'waiting' ? '…' : '✓'}</span> : null}
                </div>
                {visible.map((pill, k) => (
                  <Pill key={pill.key} pill={pill} names={names} t={t} top={layout.pillsTop + k * (PILL_HEIGHT + PILL_GAP)} onOpen={onOpenPill} onOpenWorkspace={onOpenWorkspace} />
                ))}
                {roster.more !== undefined ? (
                  <div className="dwf-pill dwf-pill-more" style={{ top: layout.pillsTop + visible.length * (PILL_HEIGHT + PILL_GAP) }}>
                    <span className="dwf-deck">
                      {roster.more.deck.map((pill) => {
                        const pName = pill.runtimeName ?? laneDisplayName(pill.lane, names)
                        return <AgentFace key={pill.key} avatarIndex={pill.avatarIndex} name={pName} status={pill.status} size={15} className="dwf-deck-face" />
                      })}
                    </span>
                    <span className="dwf-pill-name">{t('pill.more', { count: roster.more.count })}</span>
                    {roster.more.failed > 0 ? <span className="dwf-pill-failed">{t('pill.moreFailed', { count: roster.more.failed })}</span> : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
      {scrollState.hasEnd ? (
        <span className="dwf-timeline-more-badge" data-done={anyDoneBeyond ? '' : undefined} aria-hidden>
          <i /><b /><i />
        </span>
      ) : null}
      {showTrackBar ? (
        <div className="dwf-timeline-bar" aria-hidden>
          <span
            className="dwf-timeline-thumb"
            style={{
              width: `${Math.max(12, scrollState.ratio * 100).toFixed(1)}%`,
              left: `${(scrollState.offset * 100).toFixed(1)}%`,
            }}
          />
        </div>
      ) : null}
    </div>
  )
})

function Pill({
  pill,
  names,
  t,
  top,
  onOpen,
  onOpenWorkspace,
}: {
  pill: TimelinePill
  names: LaneNameFormatter
  t: Translate
  top: number
  onOpen?: ((pill: TimelinePill) => void) | undefined
  onOpenWorkspace?: ((pill: TimelinePill) => void) | undefined
}) {
  const name = pill.runtimeName ?? laneDisplayName(pill.lane, names)
  const isScript = pill.laneClass === 'workspace'
  const openActor = !isScript && onOpen !== undefined && pill.instance?.sessionId !== undefined
  const openScript = isScript && onOpenWorkspace !== undefined && pill.workspace !== undefined
  const openable = openActor || openScript
  const body = (
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
      {pill.asking === true ? <span className="dwf-pill-asking" aria-hidden>?</span> : null}
      <span className="dwf-pill-tail">
        {isScript && pill.status === 'done' ? <ScriptCheckIcon done /> : null}
        {pill.status === 'running' ? <StateDot state="ongoing" size={10} /> : null}
        {pill.status === 'failed' ? <StateDot state="error" size={10} /> : null}
        {openable ? <span className="dwf-pill-open-arrow" aria-hidden>↗</span> : null}
      </span>
    </>
  )
  return openable
    ? (
      <button
        type="button"
        className="dwf-pill dwf-pill-button"
        data-status={pill.status ?? 'static'}
        style={{ top }}
        onClick={(e) => {
          e.stopPropagation()
          if (openScript) onOpenWorkspace!(pill)
          else onOpen!(pill)
        }}
        aria-label={openScript ? t('pill.openScript') : t('pill.open', { name })}
      >
        {body}
      </button>
    )
    : (
      <div
        className="dwf-pill"
        data-status={pill.status ?? 'static'}
        style={{ top }}
      >
        {body}
      </div>
    )
}
