import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// ponytail: scaffold-only table to prove migrate + insert + read end to end.
// Real vocab-store schema (text/token/lemma/knowledge/gloss) lands in backlog #3.
export const scaffoldCheck = sqliteTable('scaffold_check', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  note: text('note').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
})
