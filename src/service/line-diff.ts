/**
 * A unified line diff for the per-subagent change lens (no dependency): an LCS over lines with
 * the common prefix and suffix trimmed first, grouped into hunks with three lines of context.
 * Bounded: past `MAX_CELLS` comparisons the middle is shown as a whole replacement instead.
 */

export interface DiffStats { added: number; removed: number }

const MAX_CELLS = 4_000_000
const CONTEXT = 3

type Op = { kind: ' ' | '-' | '+'; text: string }

function splitLines(text: string | null): string[] {
  if (text === null || text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function lineOps(a: string[], b: string[]): Op[] {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const head: Op[] = a.slice(0, start).map(text => ({ kind: ' ', text }))
  const tail: Op[] = a.slice(endA).map(text => ({ kind: ' ', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  let middle: Op[]
  if (midA.length * midB.length > MAX_CELLS) {
    middle = [...midA.map(text => ({ kind: '-' as const, text })), ...midB.map(text => ({ kind: '+' as const, text }))]
  } else {
    // LCS table from the end, then walk forward
    const n = midA.length
    const m = midB.length
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
      }
    }
    middle = []
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { middle.push({ kind: ' ', text: midA[i]! }); i += 1; j += 1 } else if (table[i + 1]![j]! >= table[i]![j + 1]!) { middle.push({ kind: '-', text: midA[i]! }); i += 1 } else { middle.push({ kind: '+', text: midB[j]! }); j += 1 }
    }
    while (i < n) middle.push({ kind: '-', text: midA[i++]! })
    while (j < m) middle.push({ kind: '+', text: midB[j++]! })
  }
  return [...head, ...middle, ...tail]
}

/** Lines added and removed between two versions (`null` = the file did not exist). */
export function diffStats(before: string | null, after: string | null): DiffStats {
  let added = 0
  let removed = 0
  for (const op of lineOps(splitLines(before), splitLines(after))) {
    if (op.kind === '+') added += 1
    else if (op.kind === '-') removed += 1
  }
  return { added, removed }
}

/** A unified diff of two versions of `path`. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const ops = lineOps(splitLines(before), splitLines(after))
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`]
  let index = 0
  let lineA = 1
  let lineB = 1
  while (index < ops.length) {
    // find the next change
    let first = index
    while (first < ops.length && ops[first]!.kind === ' ') first += 1
    if (first >= ops.length) break
    const from = Math.max(index, first - CONTEXT)
    // advance the line counters over the skipped context
    for (let k = index; k < from; k += 1) { lineA += 1; lineB += 1 }
    // extend the hunk while changes are within 2*CONTEXT of each other
    let last = first
    let k = first
    while (k < ops.length) {
      if (ops[k]!.kind !== ' ') { last = k; k += 1; continue }
      let run = k
      while (run < ops.length && ops[run]!.kind === ' ') run += 1
      if (run >= ops.length || run - k > CONTEXT * 2) break
      k = run
    }
    const to = Math.min(ops.length, last + CONTEXT + 1)
    const hunk = ops.slice(from, to)
    const countA = hunk.filter(op => op.kind !== '+').length
    const countB = hunk.filter(op => op.kind !== '-').length
    out.push(`@@ -${countA === 0 ? lineA - 1 : lineA},${countA} +${countB === 0 ? lineB - 1 : lineB},${countB} @@`)
    for (const op of hunk) {
      out.push(`${op.kind}${op.text}`)
      if (op.kind !== '+') lineA += 1
      if (op.kind !== '-') lineB += 1
    }
    index = to
  }
  return out.join('\n')
}
