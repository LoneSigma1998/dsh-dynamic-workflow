/**
 * ZCode's JournalStorePort contract suite (T1 of the assessment) against this plugin's SQLite
 * journal: the same cases ZCode runs against its own SQLite store, on a fresh in-memory database
 * per case with this plugin's schema.
 * Run: npm run test:vendor
 */

import { DatabaseSync } from 'node:sqlite'
import { runJournalStoreContract } from '../../vendor/dynamic-workflow/src/testing/index.ts'
import { createSqliteJournal } from '../../src/journal/journal.ts'
import { JOURNAL_SCHEMA } from '../../src/journal/schema.ts'

runJournalStoreContract(() => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(JOURNAL_SCHEMA)
  return createSqliteJournal(db)
})
