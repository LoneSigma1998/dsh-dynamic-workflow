/**
 * Preset dashboard artifact renderers (`artifact.chart` / `table` / `metrics` / `board`).
 *
 * Pure spec validation and projection functions sit beside thin, theme-tokenized SVG / HTML
 * renderers (no third-party chart library). Data is fetched incrementally from
 * `GET dynamic-workflow/api/runs/:runId/artifacts/:id/data` using the journal sequence cursor
 * (`after`) and SQLite field extraction (`fields`) so large report payloads stay on the Host.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Translate } from './host-types.ts'
import {
  fieldTitle,
  formatCellValue,
  isPresetArtifactKind,
  parsePresetSpec,
  projectBoard,
  projectChart,
  projectMetrics,
  projectTable,
  specFieldPaths,
  type PresetArtifactKind,
  type PresetDataItem,
  type ProjectedBoardColumn,
  type ProjectedChart,
  type ProjectedMetric,
  type ProjectedTable,
} from './model/preset-artifacts.ts'
import { apiGet } from './run-view.ts'

export {
  isPresetArtifactKind,
  parsePresetSpec,
  projectBoard,
  projectChart,
  projectMetrics,
  projectTable,
  specFieldPaths,
  type PresetArtifactKind,
  type PresetDataItem,
}

// ————————————————————————————— renderers —————————————————————————————

const SERIES_COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2']

function ChartView({ chart, t }: { chart: ProjectedChart; t: Translate }) {
  const allY = chart.series.flatMap(s => s.points.map(p => p.y))
  if (chart.baseline !== undefined && (chart.scale !== 'log' || chart.baseline.value > 0)) allY.push(chart.baseline.value)
  if (allY.length === 0) return <p className="dwf-muted">{t('artifact.preset.empty')}</p>

  const W = 460
  const H = 190
  const pad = { top: 14, right: 16, bottom: 32, left: 52 }
  const plotW = W - pad.left - pad.right
  const plotH = H - pad.top - pad.bottom

  const rawMinY = Math.min(...allY)
  const rawMaxY = Math.max(...allY)
  const minY = chart.type === 'bar' && chart.scale === 'linear' ? Math.min(0, rawMinY) : rawMinY
  const maxY = rawMaxY === minY ? (minY === 0 ? 1 : minY * 1.1) : rawMaxY

  const mapY = (v: number): number => {
    if (chart.scale === 'log') {
      const lo = Math.log10(Math.max(1e-9, minY))
      const hi = Math.log10(Math.max(1e-9, maxY))
      const ratio = hi === lo ? 0.5 : (Math.log10(Math.max(1e-9, v)) - lo) / (hi - lo)
      return pad.top + plotH * (1 - ratio)
    }
    const ratio = (v - minY) / (maxY - minY)
    return pad.top + plotH * (1 - ratio)
  }

  const allX = chart.series.flatMap(s => s.points.map(p => p.xNum ?? p.xIndex))
  const minX = Math.min(...allX)
  const maxX = Math.max(...allX)
  const count = Math.max(1, chart.categories.length)
  const mapX = (p: { xIndex: number; xNum?: number }): number => {
    if (chart.numericX && p.xNum !== undefined) {
      return maxX === minX ? pad.left + plotW / 2 : pad.left + ((p.xNum - minX) / (maxX - minX)) * plotW
    }
    return count === 1 ? pad.left + plotW / 2 : pad.left + (p.xIndex / (count - 1)) * plotW
  }

  const ticksY = [minY, chart.scale === 'log' ? Math.sqrt(minY * maxY) : (minY + maxY) / 2, maxY]
  const barGroupW = plotW / count
  const barW = Math.max(4, Math.min(28, (barGroupW * 0.72) / Math.max(1, chart.series.length)))

  return (
    <div className="dwf-preset-chart" data-dwf-preset="chart">
      <svg className="dwf-chart-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={chart.xLabel}>
        {ticksY.map((tick, idx) => {
          const y = mapY(tick)
          return (
            <g key={idx}>
              <line x1={pad.left} x2={W - pad.right} y1={y} y2={y} className="dwf-chart-grid" />
              <text x={pad.left - 6} y={y + 3} textAnchor="end" className="dwf-chart-tick">{formatCellValue(tick)}</text>
            </g>
          )
        })}
        <line x1={pad.left} x2={W - pad.right} y1={pad.top + plotH} y2={pad.top + plotH} className="dwf-chart-axis" />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={pad.top + plotH} className="dwf-chart-axis" />
        {chart.baseline !== undefined && (chart.scale !== 'log' || chart.baseline.value > 0) ? (
          <g>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={mapY(chart.baseline.value)}
              y2={mapY(chart.baseline.value)}
              className="dwf-chart-baseline"
            />
            <text x={W - pad.right - 2} y={mapY(chart.baseline.value) - 4} textAnchor="end" className="dwf-chart-tick">
              {chart.baseline.label}: {formatCellValue(chart.baseline.value, chart.baseline.unit)}
            </text>
          </g>
        ) : null}
        {chart.series.map((s, sIdx) => {
          const color = SERIES_COLORS[sIdx % SERIES_COLORS.length]!
          if (chart.type === 'bar') {
            const baseY = mapY(Math.max(minY, 0))
            return (
              <g key={s.label}>
                {s.points.map((pt, pIdx) => {
                  const center = pad.left + (pt.xIndex + 0.5) * barGroupW
                  const offset = (sIdx - (chart.series.length - 1) / 2) * (barW + 2)
                  const py = mapY(pt.y)
                  const top = Math.min(py, baseY)
                  const h = Math.max(1, Math.abs(baseY - py))
                  return (
                    <rect key={pIdx} x={center + offset - barW / 2} y={top} width={barW} height={h} fill={color} rx={2}>
                      <title>{`${s.label} · ${pt.xLabel}: ${formatCellValue(pt.y, s.unit)}`}</title>
                    </rect>
                  )
                })}
              </g>
            )
          }
          const path = chart.type === 'line' && s.points.length > 1
            ? s.points.map((pt, pIdx) => `${pIdx === 0 ? 'M' : 'L'}${mapX(pt).toFixed(1)},${mapY(pt.y).toFixed(1)}`).join(' ')
            : undefined
          return (
            <g key={s.label}>
              {path !== undefined ? <path d={path} fill="none" stroke={color} strokeWidth={1.75} /> : null}
              {s.points.map((pt, pIdx) => (
                <circle key={pIdx} cx={mapX(pt)} cy={mapY(pt.y)} r={chart.type === 'scatter' ? 3.5 : 2.5} fill={color}>
                  <title>{`${s.label} · ${pt.xLabel}: ${formatCellValue(pt.y, s.unit)}`}</title>
                </circle>
              ))}
            </g>
          )
        })}
        {chart.categories.length > 0 ? (
          <>
            <text x={pad.left} y={H - 10} textAnchor="start" className="dwf-chart-tick">{chart.categories[0]}</text>
            {chart.categories.length > 1 ? (
              <text x={W - pad.right} y={H - 10} textAnchor="end" className="dwf-chart-tick">{chart.categories[chart.categories.length - 1]}</text>
            ) : null}
          </>
        ) : null}
      </svg>
      <div className="dwf-chart-legend">
        {chart.series.map((s, idx) => (
          <span key={s.label} className="dwf-chart-legend-item">
            <span className="dwf-chart-swatch" style={{ background: SERIES_COLORS[idx % SERIES_COLORS.length] }} />
            {s.label}{s.unit === undefined ? '' : ` (${s.unit})`}
          </span>
        ))}
      </div>
    </div>
  )
}

function MetricsView({ metrics, t }: { metrics: readonly ProjectedMetric[]; t: Translate }) {
  if (metrics.every(m => m.value === undefined)) return <p className="dwf-muted">{t('artifact.preset.empty')}</p>
  return (
    <div className="dwf-metrics-grid" data-dwf-preset="metrics">
      {metrics.map(metric => (
        <div key={metric.field} className="dwf-metric-tile">
          <span className="dwf-metric-label">{metric.label}</span>
          <span className="dwf-metric-value">{formatCellValue(metric.value, metric.unit)}</span>
        </div>
      ))}
    </div>
  )
}

function TableView({ table, t }: { table: ProjectedTable; t: Translate }) {
  if (table.rows.length === 0) return <p className="dwf-muted">{t('artifact.preset.empty')}</p>
  return (
    <div className="dwf-table-wrap" data-dwf-preset="table">
      <table className="dwf-table">
        <thead>
          <tr>
            {table.columns.map(col => <th key={col.field}>{fieldTitle(col)}{col.unit === undefined ? '' : ` (${col.unit})`}</th>)}
          </tr>
        </thead>
        <tbody>
          {table.rows.map(row => (
            <tr key={row.key}>
              {row.cells.map((cell, idx) => <td key={table.columns[idx]!.field}>{formatCellValue(cell, table.columns[idx]!.unit)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BoardView({ columns, t }: { columns: readonly ProjectedBoardColumn[]; t: Translate }) {
  if (columns.every(col => col.cards.length === 0)) return <p className="dwf-muted">{t('artifact.preset.empty')}</p>
  return (
    <div className="dwf-board" data-dwf-preset="board">
      {columns.map(col => (
        <div key={col.name} className="dwf-board-col">
          <div className="dwf-board-col-head">
            <span>{col.other === true ? t('artifact.board.other') : col.name}</span>
            <span className="dwf-muted">{col.cards.length}</span>
          </div>
          <div className="dwf-board-cards">
            {col.cards.map(card => (
              <div key={card.key} className="dwf-board-card">
                <div className="dwf-board-card-title">{card.title}</div>
                {card.details.length > 0 ? (
                  <div className="dwf-board-card-meta">
                    {card.details.map(detail => <span key={detail.label}>{detail.label}: {detail.value}</span>)}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Pure presentational preset body (shared by live pane and tests/preview). */
export function PresetArtifactView({ kind, spec, items, t }: {
  kind: PresetArtifactKind
  spec: unknown
  items: readonly PresetDataItem[]
  t: Translate
}) {
  const parsed = useMemo(() => parsePresetSpec(kind, spec), [kind, spec])
  if (parsed === undefined) return <p className="dwf-muted">{t('artifact.preset.invalid')}</p>
  switch (parsed.kind) {
    case 'chart': return <ChartView chart={projectChart(parsed.spec, items)} t={t} />
    case 'table': return <TableView table={projectTable(parsed.spec, items)} t={t} />
    case 'metrics': return <MetricsView metrics={projectMetrics(parsed.spec, items)} t={t} />
    case 'board': return <BoardView columns={projectBoard(parsed.spec, items)} t={t} />
  }
}

const MAX_LOADED_ITEMS = 2000

/** Incremental cursor-backed loader for one preset dashboard artifact. */
export function PresetArtifactLoader({ runId, artifactId, kind, spec, itemCount, t }: {
  runId: string
  artifactId: string
  kind: PresetArtifactKind
  spec: unknown
  itemCount?: number
  t: Translate
}) {
  const parsed = useMemo(() => parsePresetSpec(kind, spec), [kind, spec])
  const fieldsQuery = useMemo(() => (parsed === undefined ? '' : specFieldPaths(parsed).join(',')), [parsed])
  const [items, setItems] = useState<PresetDataItem[]>([])
  const [failed, setFailed] = useState(false)
  const cursorRef = useRef<number>(-1)
  const identity = `${runId}\u0000${artifactId}`
  const prevIdentity = useRef(identity)
  if (prevIdentity.current !== identity) {
    prevIdentity.current = identity
    cursorRef.current = -1
  }

  useEffect(() => {
    setItems([])
    cursorRef.current = -1
  }, [runId, artifactId])

  useEffect(() => {
    if (parsed === undefined) return
    const controller = new AbortController()
    let active = true
    const fetchMore = async (): Promise<void> => {
      try {
        let totalLoaded = 0
        for (let page = 0; page < 10 && active; page += 1) {
          const params = new URLSearchParams({ limit: '200' })
          if (cursorRef.current >= 0) params.set('after', String(cursorRef.current))
          if (fieldsQuery !== '') params.set('fields', fieldsQuery)
          const res = await apiGet<{ items: PresetDataItem[]; hasMore: boolean }>(
            `runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/data?${params.toString()}`,
            controller.signal,
          )
          if (!active) return
          if (res.items.length > 0) {
            cursorRef.current = res.items[res.items.length - 1]!.sequence
            totalLoaded += res.items.length
            setItems((prev) => {
              const seen = new Set(prev.map(i => i.sequence))
              const added = res.items.filter(i => !seen.has(i.sequence))
              return added.length === 0 ? prev : [...prev, ...added].slice(-MAX_LOADED_ITEMS)
            })
          }
          setFailed(false)
          if (!res.hasMore || res.items.length === 0 || totalLoaded >= MAX_LOADED_ITEMS) break
        }
      } catch {
        if (!controller.signal.aborted && active) setFailed(true)
      }
    }
    void fetchMore()
    return () => { active = false; controller.abort() }
  }, [runId, artifactId, fieldsQuery, parsed, itemCount])

  if (failed && items.length === 0) return <p className="dwf-attention">{t('artifact.failed')}</p>
  return <PresetArtifactView kind={kind} spec={spec} items={items} t={t} />
}
