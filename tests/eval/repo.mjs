/**
 * The seeded repository for the A/B experiment: twelve small TypeScript modules with 14 planted
 * bugs (ground truth: file + line) and 5 decoys — code that looks wrong but is correct, each
 * with the reason it is correct kept OUT of the files (so a reviewer has to reason, not read a
 * comment). Line numbers are 1-based and refer to the line carrying the defect.
 */

export const FILES = {
  'src/math/stats.ts': `export function mean(values: number[]): number {
  if (values.length === 0) return 0
  let sum = 0
  for (let i = 0; i <= values.length - 1; i++) sum += values[i]
  return sum / values.length
}

export function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort()
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function variance(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  const squares = values.map(v => (v - m) ** 2)
  return squares.reduce((a, b) => a + b, 0) / values.length - 1
}
`,
  'src/math/range.ts': `export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new RangeError('min > max')
  return Math.min(max, Math.max(min, value))
}

export function range(start: number, end: number, step = 1): number[] {
  if (step <= 0) throw new RangeError('step must be positive')
  const out: number[] = []
  for (let i = start; i < end; i += step) out.push(i)
  return out
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round(part / whole * 100)
}

export function inRange(value: number, min: number, max: number): boolean {
  return value > min && value <= max
}
`,
  'src/text/slug.ts': `export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/, '')
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

export function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)
}
`,
  'src/text/template.ts': `export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\\{\\{(\\w+)\\}\\}/g, (_, key) => vars[key] ?? '')
}

export function escapeHtml(text: string): string {
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
}

export function countWords(text: string): number {
  const words = text.trim().split(/\\s+/)
  return words.length
}
`,
  'src/data/cache.ts': `export class LruCache<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly capacity: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.capacity) {
      const newest = [...this.map.keys()][this.map.size - 1]
      this.map.delete(newest)
    }
  }

  get size(): number {
    return this.map.size
  }
}
`,
  'src/data/queue.ts': `export class Queue<T> {
  private items: T[] = []
  private head = 0

  push(item: T): void {
    this.items.push(item)
  }

  shift(): T | undefined {
    if (this.head >= this.items.length) return undefined
    const item = this.items[this.head]
    this.head += 1
    if (this.head > 64 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return item
  }

  get length(): number {
    return this.items.length
  }
}
`,
  'src/data/group.ts': `export function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const item of items) {
    const k = key(item)
    if (!out[k]) out[k] = []
    out[k].push(item)
  }
  return out
}

export function unique<T>(items: T[]): T[] {
  return items.filter((item, index) => items.indexOf(item) === index)
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
`,
  'src/time/dates.ts': `export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && year % 100 !== 0 || year % 400 === 0
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate()
}

export function addDays(date: Date, days: number): Date {
  const out = new Date(date)
  out.setDate(out.getDate() + days)
  return out
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 7
}
`,
  'src/time/duration.ts': `export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  if (hours > 0) return \`\${hours}h \${minutes % 60}m\`
  if (minutes > 0) return \`\${minutes}m \${seconds}s\`
  return \`\${seconds}s\`
}

export function parseDuration(text: string): number {
  const match = /^(\\d+)(ms|s|m|h)$/.exec(text)
  if (match === null) throw new Error('bad duration')
  const n = Number(match[1])
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ms' | 's' | 'm' | 'h']
  return n * unit
}
`,
  'src/net/retry.ts': `export async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 100): Promise<T> {
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** i))
    }
  }
  throw last
}

export function backoff(attempt: number, base = 100, cap = 10_000): number {
  return Math.min(cap, base * 2 ** attempt)
}
`,
  'src/net/url.ts': `export function joinUrl(base: string, path: string): string {
  return base.replace(/\\/+$/, '') + '/' + path.replace(/^\\/+/, '')
}

export function parseQuery(query: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of query.replace(/^\\?/, '').split('&')) {
    if (part === '') continue
    const [key, value = ''] = part.split('=')
    out[decodeURIComponent(key)] = value
  }
  return out
}

export function isHttps(url: string): boolean {
  return url.startsWith('https://')
}
`,
  'src/auth/token.ts': `export function isExpired(expiresAt: number, now = Date.now()): boolean {
  return expiresAt < now
}

export function maskToken(token: string): string {
  if (token.length <= 8) return '*'.repeat(token.length)
  return token.slice(0, 4) + '*'.repeat(token.length - 8) + token.slice(-4)
}

export function bearer(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const [scheme, value] = header.split(' ')
  return scheme === 'Bearer' ? value : undefined
}
`,
}

/** Planted bugs: the line carrying the defect, and what it is. */
export const BUGS = [
  { id: 'median-sort', file: 'src/math/stats.ts', line: 10, what: 'sort() without comparator sorts numbers lexicographically' },
  { id: 'variance-precedence', file: 'src/math/stats.ts', line: 19, what: '/ values.length - 1 instead of / (values.length - 1): operator precedence' },
  { id: 'inrange-bounds', file: 'src/math/range.ts', line: 18, what: 'value > min excludes min (inconsistent inclusive range)' },
  { id: 'slug-trailing-dash', file: 'src/text/slug.ts', line: 6, what: 'replace(/^-|-$/) without g strips only one side' },
  { id: 'escape-order', file: 'src/text/template.ts', line: 9, what: '& escaped after < and > double-escapes the entities' },
  { id: 'countwords-empty', file: 'src/text/template.ts', line: 14, what: 'empty string counts as one word' },
  { id: 'lru-evicts-newest', file: 'src/data/cache.ts', line: 17, what: 'evicts the newest entry instead of the oldest' },
  { id: 'queue-length', file: 'src/data/queue.ts', line: 21, what: 'length ignores consumed head items' },
  { id: 'weekend-sunday', file: 'src/time/dates.ts', line: 17, what: 'getDay() never returns 7; Saturday (6) missed' },
  { id: 'duration-seconds', file: 'src/time/duration.ts', line: 6, what: 'minutes branch prints total seconds instead of seconds % 60' },
  { id: 'retry-last-sleep', file: 'src/net/retry.ts', line: 8, what: 'sleeps after the final failed attempt for no reason' },
  { id: 'query-value-decode', file: 'src/net/url.ts', line: 10, what: 'value not URI-decoded (and values containing = are cut)' },
  { id: 'expired-boundary', file: 'src/auth/token.ts', line: 2, what: 'expiresAt === now not treated as expired' },
  { id: 'bearer-case', file: 'src/auth/token.ts', line: 12, what: 'split(" ") breaks on extra spaces; scheme compare is case-sensitive' },
]

/** Decoys: lines that look suspicious but are correct. A finding here is a false positive. */
export const DECOYS = [
  { id: 'mean-loop', file: 'src/math/stats.ts', line: 4, why: 'i <= length - 1 is the same as i < length' },
  { id: 'days-in-month', file: 'src/time/dates.ts', line: 6, why: 'day 0 of month m (1-based) is the last day of month m' },
  { id: 'truncate-ellipsis', file: 'src/text/slug.ts', line: 11, why: 'max - 1 chars plus the ellipsis is exactly max' },
  { id: 'leap-precedence', file: 'src/time/dates.ts', line: 2, why: '&& binds tighter than ||: the standard leap-year rule' },
  { id: 'queue-compaction', file: 'src/data/queue.ts', line: 13, why: 'compaction keeps the unread tail; head resets to 0' },
]

export const PROMPT_BODY = '审查 src/ 下的全部 TypeScript 文件，找出所有明确的 bug（会导致错误结果或异常的缺陷，不要风格建议）。只读，不要修改任何文件。最后在回答末尾给出一个 ```json 代码块：[{"file": "src/...", "line": 行号, "bug": "一句话原因"}]，只列你确认是 bug 的条目。'
