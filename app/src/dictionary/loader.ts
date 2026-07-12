import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { dictEntry, dictForm, dictSense } from '#/db/schema'
import type { ParsedEntry } from './parse'

type DB = BetterSQLite3Database<typeof schema>

/** Delete the whole home dictionary (senses/forms cascade). Returns entries deleted. */
export function wipeDictionary(db: DB): number {
  return db.delete(dictEntry).run().changes
}

/** Insert one batch of parsed entries in a single transaction. */
export function insertEntryBatch(db: DB, entries: ParsedEntry[]): void {
  if (entries.length === 0) return
  db.transaction((tx) => {
    for (const e of entries) {
      const [{ id: entryId }] = tx
        .insert(dictEntry)
        .values({
          word: e.word,
          pos: e.pos,
          ipa: e.ipa,
          etymology: e.etymology,
          isMwe: e.isMwe,
        })
        .returning({ id: dictEntry.id })
        .all()
      if (e.senses.length > 0) {
        tx.insert(dictSense)
          .values(
            e.senses.map((s, i) => ({
              entryId,
              senseIndex: i,
              gloss: s.gloss,
              rawGloss: s.rawGloss,
              tags: s.tags,
            })),
          )
          .run()
      }
      if (e.forms.length > 0) {
        tx.insert(dictForm)
          .values(e.forms.map((f) => ({ entryId, form: f.form, tags: f.tags })))
          .run()
      }
    }
  })
}
