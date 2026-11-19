// Pure spec parsing and data projections for preset dashboard artifacts
// (`artifact.chart` / `table` / `metrics` / `board`). No React or DOM.

import { readWorkflowArtifactField } from '../../shared/runs/workflow-artifacts.ts'

export type PresetArtifactKind = 'chart' | 'table' | 'metrics' | 'board'

export function isPresetArtifactKind(kind: string): kind is PresetArtifactKind {
  return kind === 'chart' || kind === 'table' || kind === 'metrics' || kind === 'board'
}

export interface PresetFieldSpec {
  field: string
  label?: string
  unit?: string
}

export interface ChartPresetSpec {
  type: 'line' | 'bar' | 'scatter'
  x: PresetFieldSpec
  y: PresetFieldSpec[]
  scale: 'linear' | 'log'
  baseline?: PresetFieldSpec
}

export interface TablePresetSpec {
  columns: PresetFieldSpec[]
  key?: string
}

export interface MetricsPresetSpec {
  metrics: PresetFieldSpec[]
}

export interface BoardPresetSpec {
  key: string
  status: string
  columns: string[]
  cardTitle?: string
  detail: PresetFieldSpec[]
}

export type ParsedPresetSpec =
  | { kind: 'chart'; spec: ChartPresetSpec }
  | { kind: 'table'; spec: TablePresetSpec }
  | { kind: 'metrics'; spec: MetricsPresetSpec }
  | { kind: 'board'; spec: BoardPresetSpec }

export interface PresetDataItem {
  sequence: number
  siteId: string
  ordinal: number
  item?: unknown
  fields?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseField(raw: unknown): PresetFieldSpec | undefined {
  if (!isRecord(raw) || typeof raw.field !== 'string' || raw.field.trim() === '') return undefined
  return {
    field: raw.field,
    ...typeof raw.label === 'string' && raw.label.length > 0 ? { label: raw.label } : {},
    ...typeof raw.unit === 'string' && raw.unit.length > 0 ? { unit: raw.unit } : {},
  }
}

export function parsePresetSpec(kind: PresetArtifactKind, raw: unknown): ParsedPresetSpec | undefined {
  if (!isRecord(raw)) return undefined
  switch (kind) {
    case 'chart': {
      const x = parseField(raw.x)
      if (x === undefined) return undefined
      const rawY = Array.isArray(raw.y) ? raw.y : raw.y === undefined ? [] : [raw.y]
      const y = rawY.map(parseField).filter((item): item is PresetFieldSpec => item !== undefined)
      if (y.length === 0) return undefined
      const type = raw.type === 'bar' || raw.type === 'scatter' ? raw.type : 'line'
      const scale = raw.scale === 'log' ? 'log' : 'linear'
      const baseline = raw.baseline === undefined ? undefined : parseField(raw.baseline)
      return { kind: 'chart', spec: { type, x, y, scale, ...baseline === undefined ? {} : { baseline } } }
    }
    case 'table': {
      if (!Array.isArray(raw.columns)) return undefined
      const columns = raw.columns.map(parseField).filter((item): item is PresetFieldSpec => item !== undefined)
      if (columns.length === 0) return undefined
      const key = typeof raw.key === 'string' && raw.key.length > 0 ? raw.key : undefined
      return { kind: 'table', spec: { columns, ...key === undefined ? {} : { key } } }
    }
    case 'metrics': {
      if (!Array.isArray(raw.metrics)) return undefined
      const metrics = raw.metrics.map(parseField).filter((item): item is PresetFieldSpec => item !== undefined)
      if (metrics.length === 0) return undefined
      return { kind: 'metrics', spec: { metrics } }
    }
    case 'board': {
      if (typeof raw.key !== 'string' || raw.key === '' || typeof raw.status !== 'string' || raw.status === '') return undefined
      if (!Array.isArray(raw.columns)) return undefined
      const columns = raw.columns.filter((col): col is string => typeof col === 'string' && col.length > 0)
      if (columns.length === 0) return undefined
      const cardTitle = typeof raw.cardTitle === 'string' && raw.cardTitle.length > 0 ? raw.cardTitle : undefined
      const detail = Array.isArray(raw.detail)
        ? raw.detail.map(parseField).filter((item): item is PresetFieldSpec => item !== undefined)
        : []
      return { kind: 'board', spec: { key: raw.key, status: raw.status, columns, ...cardTitle === undefined ? {} : { cardTitle }, detail } }
    }
  }
}

/** Exact dot-paths a preset reads, sent as `?fields=` so SQLite extracts only those values. */
export function specFieldPaths(parsed: ParsedPresetSpec): string[] {
  const paths = new Set<string>()
  switch (parsed.kind) {
    case 'chart':
      paths.add(parsed.spec.x.field)
      for (const y of parsed.spec.y) paths.add(y.field)
      if (parsed.spec.baseline !== undefined) paths.add(parsed.spec.baseline.field)
      break
    case 'table':
      if (parsed.spec.key !== undefined) paths.add(parsed.spec.key)
      for (const col of parsed.spec.columns) paths.add(col.field)
      break
    case 'metrics':
      for (const metric of parsed.spec.metrics) paths.add(metric.field)
      break
    case 'board':
      paths.add(parsed.spec.key)
      paths.add(parsed.spec.status)
      if (parsed.spec.cardTitle !== undefined) paths.add(parsed.spec.cardTitle)
      for (const field of parsed.spec.detail) paths.add(field.field)
      break
  }
  return [...paths]
}

export function readItemField(entry: PresetDataItem, path: string): unknown {
  if (entry.fields !== undefined) return entry.fields[path]
  return readWorkflowArtifactField(entry.item, path)
}

export function fieldTitle(spec: PresetFieldSpec): string {
  return spec.label ?? spec.field
}

export function formatCellValue(value: unknown, unit?: string): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'number') {
    const formatted = Number.isInteger(value) ? value.toLocaleString() : Number(value.toPrecision(4)).toString()
    return unit === undefined ? formatted : `${formatted} ${unit}`
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return unit === undefined ? value : `${value} ${unit}`
  try {
    const text = JSON.stringify(value)
    return text.length > 120 ? `${text.slice(0, 119)}…` : text
  } catch {
    return String(value)
  }
}

export interface ProjectedMetric { field: string; label: string; unit?: string; value: unknown }

export function projectMetrics(spec: MetricsPresetSpec, items: readonly PresetDataItem[]): ProjectedMetric[] {
  return spec.metrics.map((metric) => {
    let latest: unknown
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const value = readItemField(items[i]!, metric.field)
      if (value !== undefined) {
        latest = value
        break
      }
    }
    return { field: metric.field, label: fieldTitle(metric), ...metric.unit === undefined ? {} : { unit: metric.unit }, value: latest }
  })
}

export interface ProjectedTable { columns: PresetFieldSpec[]; rows: { key: string; cells: unknown[] }[] }

export function projectTable(spec: TablePresetSpec, items: readonly PresetDataItem[]): ProjectedTable {
  const rows: { key: string; cells: unknown[] }[] = []
  const byKey = new Map<string, number>()
  for (const entry of items) {
    const cells = spec.columns.map(col => readItemField(entry, col.field))
    const rawKey = spec.key === undefined ? undefined : readItemField(entry, spec.key)
    const rowKey = rawKey === undefined || rawKey === null ? `${entry.siteId}@${entry.ordinal}:${entry.sequence}` : String(rawKey)
    if (spec.key !== undefined && rawKey !== undefined && rawKey !== null) {
      const existing = byKey.get(rowKey)
      if (existing !== undefined) {
        rows[existing] = { key: rowKey, cells }
        continue
      }
      byKey.set(rowKey, rows.length)
    }
    rows.push({ key: rowKey, cells })
  }
  return { columns: spec.columns, rows }
}

export interface ProjectedBoardColumn {
  name: string
  other?: true
  cards: { key: string; title: string; details: { label: string; value: string }[] }[]
}

export function projectBoard(spec: BoardPresetSpec, items: readonly PresetDataItem[]): ProjectedBoardColumn[] {
  const byKey = new Map<string, { status: string; title: string; details: { label: string; value: string }[] }>()
  for (const entry of items) {
    const rawKey = readItemField(entry, spec.key)
    if (rawKey === undefined || rawKey === null) continue
    const key = String(rawKey)
    const rawStatus = readItemField(entry, spec.status)
    const status = rawStatus === undefined || rawStatus === null ? '' : String(rawStatus)
    const rawTitle = spec.cardTitle === undefined ? rawKey : (readItemField(entry, spec.cardTitle) ?? rawKey)
    const details = spec.detail.flatMap((field) => {
      const val = readItemField(entry, field.field)
      return val === undefined ? [] : [{ label: fieldTitle(field), value: formatCellValue(val, field.unit) }]
    })
    byKey.set(key, { status, title: String(rawTitle), details })
  }
  const declared = new Set(spec.columns)
  const columns: ProjectedBoardColumn[] = spec.columns.map(name => ({ name, cards: [] }))
  const otherCards: ProjectedBoardColumn['cards'] = []
  for (const [key, card] of byKey) {
    const item = { key, title: card.title, details: card.details }
    if (declared.has(card.status)) {
      columns.find(col => col.name === card.status)!.cards.push(item)
    } else {
      otherCards.push(item)
    }
  }
  if (otherCards.length > 0) columns.push({ name: '__other__', other: true, cards: otherCards })
  return columns
}

export interface ProjectedChartSeries {
  label: string
  unit?: string
  points: { xIndex: number; xNum?: number; xLabel: string; y: number }[]
}

export interface ProjectedChart {
  type: 'line' | 'bar' | 'scatter'
  scale: 'linear' | 'log'
  xLabel: string
  numericX: boolean
  categories: string[]
  series: ProjectedChartSeries[]
  baseline?: { label: string; value: number; unit?: string }
}

export function projectChart(spec: ChartPresetSpec, items: readonly PresetDataItem[]): ProjectedChart {
  const categories: string[] = []
  let numericX = items.length > 0
  let baseline: ProjectedChart['baseline']
  const rawRows: { xLabel: string; xNum?: number; ys: (number | undefined)[] }[] = []
  for (const entry of items) {
    const rawX = readItemField(entry, spec.x.field)
    if (rawX === undefined || rawX === null) continue
    const xNum = typeof rawX === 'number' && Number.isFinite(rawX) ? rawX : undefined
    if (xNum === undefined) numericX = false
    const xLabel = formatCellValue(rawX, spec.x.unit)
    if (spec.baseline !== undefined && baseline === undefined) {
      const baseVal = readItemField(entry, spec.baseline.field)
      if (typeof baseVal === 'number' && Number.isFinite(baseVal)) {
        baseline = { label: fieldTitle(spec.baseline), value: baseVal, ...spec.baseline.unit === undefined ? {} : { unit: spec.baseline.unit } }
      }
    }
    const ys = spec.y.map((yField) => {
      const value = readItemField(entry, yField.field)
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      if (spec.scale === 'log' && value <= 0) return undefined
      return value
    })
    if (ys.every(v => v === undefined)) continue
    categories.push(xLabel)
    rawRows.push({ xLabel, ...xNum === undefined ? {} : { xNum }, ys })
  }
  const series: ProjectedChartSeries[] = spec.y.map((yField, seriesIdx) => ({
    label: fieldTitle(yField),
    ...yField.unit === undefined ? {} : { unit: yField.unit },
    points: rawRows.flatMap((row, idx) => {
      const y = row.ys[seriesIdx]
      return y === undefined ? [] : [{ xIndex: idx, ...row.xNum === undefined ? {} : { xNum: row.xNum }, xLabel: row.xLabel, y }]
    }),
  }))
  return {
    type: spec.type,
    scale: spec.scale,
    xLabel: fieldTitle(spec.x),
    numericX: numericX && spec.type !== 'bar',
    categories,
    series,
    ...baseline === undefined ? {} : { baseline },
  }
}
