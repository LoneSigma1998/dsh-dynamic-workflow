/**
 * The plugin's SQLite journal: ZCode's `SqliteDwfJournalStore` (ported verbatim
 * under `./zcode/`, Apache-2.0) plus the two host-side queries the DSH run
 * service needs (session run list, cold-start orphan scan).
 */

import { uptime } from 'node:os'
import type { DatabaseSync } from 'node:sqlite'
import type { RunRecord } from '@zcode/dynamic-workflow'
import { decodeRun, encodeRunSettlement, type DwfRunRow } from './zcode/dwf-journal-codecs.ts'
import { SqliteDwfJournalStore } from './zcode/dwf-journal.ts'

export class SqliteJournal extends SqliteDwfJournalStore {
  constructor(db: DatabaseSync) {
    super(db)
  }

  get database(): DatabaseSync {
    return this.db
  }

  /** Recent runs, optionally of one owning session; newest first. */
  listRunRows(parentSessionId: string | undefined, limit: number): { runId: string; name: string; status: string; stopReason?: string; spentTokens: number; updated: number; parentSessionId?: string }[] {
    const rows = parentSessionId === undefined
      ? this.listRuns({ limit })
      : this.listRunsByParentSession(parentSessionId, limit)
    return rows.map(row => ({
      runId: row.runId,
      name: row.name ?? row.runId,
      status: row.status,
      ...row.stopReason === undefined ? {} : { stopReason: row.stopReason },
      spentTokens: row.spentTokens,
      updated: row.timeUpdated,
      ...row.parentSessionId === undefined ? {} : { parentSessionId: row.parentSessionId },
    }))
  }

  /** Every run left non-terminal by a dead process (any owner), read atomically in one query. */
  listNonTerminalRunsAll(): RunRecord[] {
    const rows = this.db
      .prepare(`select * from dwf_run where status not in ('completed','failed','cancelled') order by id`)
      .all() as unknown as DwfRunRow[]
    return rows.map(decodeRun)
  }

  /**
   * Atomically mark an orphaned non-terminal run as `stopped(interrupted)` only if it is still
   * non-terminal in SQLite (prevents a concurrent Host from having its completed status overwritten).
   */
  markInterruptedIfNonTerminal(runId: string, failure: { code: string; message: string }): boolean {
    const encoded = encodeRunSettlement('stopped', { stopReason: 'interrupted', failure: failure as never })
    const { changes } = this.db
      .prepare(`update dwf_run set status = ?, failure_json = ?, time_updated = ? where id = ? and status not in ('completed','failed','cancelled')`)
      .run(encoded.status, encoded.failureJson, Date.now(), runId)
    return changes > 0
  }
}

/** One process's claim on the runs it executes (see `dsh_dwf_run_owner`). */
/** This machine's boot time (epoch ms): a pid recorded before a reboot says nothing after it. */
function bootTime(): number {
  return Math.round(Date.now() - uptime() * 1000)
}

/**
 * Two readings of the boot time on the same boot differ by clock jitter and wall-clock
 * corrections (NTP, sleep): compared with a tolerance, never for equality — a rounding edge
 * must not turn a live owner into an orphan.
 */
const SAME_BOOT_TOLERANCE_MS = 120_000

/**
 * Which process executes a run (several Hosts may share one DSH_HOME: the desktop app, `dsh web`,
 * a headless run). A run is owned elsewhere while its owner process is alive on this boot; the
 * heartbeat is kept for diagnostics, not as a lease, because a laptop that slept stops every
 * heartbeat at once and must not hand live runs to whichever Host wakes first.
 *
 * Write fencing: an owner that finds its claim replaced (another Host took the run over, e.g.
 * after this process was suspended) stops writing that run at once — see `lost()`.
 */
export class RunOwnership {
  /** `<pid>-<boot>-<random>`: distinguishes this process from any earlier one with the same pid. */
  readonly instance = `${process.pid}-${bootTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  private readonly claimed = new Set<string>()

  constructor(private readonly db: DatabaseSync) {}

  claim(runId: string): void {
    this.db.prepare('insert into dsh_dwf_run_owner (run_id, pid, instance, heartbeat) values (?, ?, ?, ?) on conflict(run_id) do update set pid = excluded.pid, instance = excluded.instance, heartbeat = excluded.heartbeat')
      .run(runId, process.pid, this.instance, Date.now())
    this.claimed.add(runId)
  }

  release(runId: string): void {
    this.claimed.delete(runId)
    this.db.prepare('delete from dsh_dwf_run_owner where run_id = ? and instance = ?').run(runId, this.instance)
  }

  /** Refresh the heartbeat of every run this process owns. */
  beat(): void {
    this.db.prepare('update dsh_dwf_run_owner set heartbeat = ? where instance = ?').run(Date.now(), this.instance)
  }

  /** Whether another process has replaced this process's claim on `runId` (cheap; checked before writes). */
  takenOver(runId: string): boolean {
    if (!this.claimed.has(runId)) return false
    const row = this.db.prepare('select instance from dsh_dwf_run_owner where run_id = ?').get(runId) as { instance: string } | undefined
    return row !== undefined && row.instance !== this.instance
  }

  /** Runs this process claimed whose claim another process has since replaced: stop writing them. */
  lost(): string[] {
    const out: string[] = []
    for (const runId of this.claimed) {
      const row = this.db.prepare('select instance from dsh_dwf_run_owner where run_id = ?').get(runId) as { instance: string } | undefined
      if (row !== undefined && row.instance !== this.instance) out.push(runId)
    }
    for (const runId of out) this.claimed.delete(runId)
    return out
  }

  /** Whether another live process (on this boot) executes this run. */
  ownedElsewhere(runId: string): boolean {
    const row = this.db.prepare('select pid, instance from dsh_dwf_run_owner where run_id = ?').get(runId) as { pid: number; instance: string } | undefined
    if (row === undefined || row.instance === this.instance) return false
    // recorded before a reboot (or by an older version): its pid may name another process now
    const recordedBoot = Number.parseInt(row.instance.split('-')[1] ?? '', 36)
    if (!Number.isFinite(recordedBoot) || Math.abs(recordedBoot - bootTime()) > SAME_BOOT_TOLERANCE_MS) return false
    try {
      process.kill(row.pid, 0)
      return true
    } catch (error) {
      // EPERM: the process exists but belongs to another user — still alive.
      return (error as { code?: string }).code === 'EPERM'
    }
  }
}

/** Content kept per side of a file change; larger files are listed but not diffed. */
export const FILE_CHANGE_MAX_BYTES = 512 * 1024

export interface FileChangeRow { runId: string; sessionId: string; actor?: string; path: string; edits: number; beforeMissing: boolean; afterMissing: boolean; tooLarge: boolean; timeUpdated: number }

/** What each subagent changed through file tools (the per-subagent change lens). */
export class FileChanges {
  constructor(private readonly db: DatabaseSync) {}

  /** The content before this subagent's first change of `path` (first call wins). */
  before(runId: string, sessionId: string, actor: string | undefined, path: string, content: string | null): void {
    const tooLarge = content !== null && Buffer.byteLength(content, 'utf8') > FILE_CHANGE_MAX_BYTES
    const now = Date.now()
    this.db.prepare('insert into dsh_dwf_file_change (run_id, session_id, actor, path, before_text, before_missing, too_large, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(run_id, session_id, path) do nothing')
      .run(runId, sessionId, actor ?? null, path, tooLarge ? null : content, content === null ? 1 : 0, tooLarge ? 1 : 0, now, now)
  }

  /** The content after this subagent's latest change of `path`. */
  after(runId: string, sessionId: string, path: string, content: string | null): void {
    const tooLarge = content !== null && Buffer.byteLength(content, 'utf8') > FILE_CHANGE_MAX_BYTES
    this.db.prepare('update dsh_dwf_file_change set after_text = ?, after_missing = ?, too_large = max(too_large, ?), edits = edits + 1, time_updated = ? where run_id = ? and session_id = ? and path = ?')
      .run(tooLarge ? null : content, content === null ? 1 : 0, tooLarge ? 1 : 0, Date.now(), runId, sessionId, path)
  }

  list(runId: string): FileChangeRow[] {
    const rows = this.db.prepare('select run_id, session_id, actor, path, edits, before_missing, after_missing, too_large, time_updated from dsh_dwf_file_change where run_id = ? and edits > 0 order by time_created').all(runId) as { run_id: string; session_id: string; actor: string | null; path: string; edits: number; before_missing: number; after_missing: number; too_large: number; time_updated: number }[]
    return rows.map(row => ({ runId: row.run_id, sessionId: row.session_id, ...row.actor === null ? {} : { actor: row.actor }, path: row.path, edits: row.edits, beforeMissing: row.before_missing === 1, afterMissing: row.after_missing === 1, tooLarge: row.too_large === 1, timeUpdated: row.time_updated }))
  }

  get(runId: string, sessionId: string, path: string): { before: string | null; after: string | null; tooLarge: boolean } | undefined {
    const row = this.db.prepare('select before_text, before_missing, after_text, after_missing, too_large from dsh_dwf_file_change where run_id = ? and session_id = ? and path = ?').get(runId, sessionId, path) as { before_text: string | null; before_missing: number; after_text: string | null; after_missing: number; too_large: number } | undefined
    if (row === undefined) return undefined
    return { before: row.before_missing === 1 ? null : row.before_text ?? '', after: row.after_missing === 1 ? null : row.after_text ?? '', tooLarge: row.too_large === 1 }
  }
}

export function createSqliteJournal(db: DatabaseSync): SqliteJournal {
  return new SqliteJournal(db)
}
