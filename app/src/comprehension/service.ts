import { asc, eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '#/db/schema'
import { comprehensionQuestion, sourceText } from '#/db/schema'
import { type GlossProvider, getGlossProvider } from '#/llm/provider'

type DB = BetterSQLite3Database<typeof schema>

export interface ComprehensionCheck {
  questions: { question: string; choices: string[]; correctIndex: number }[]
  cached: boolean // true = served from cache (no provider call)
}

/**
 * Comprehension-check MCQs for a text, cached in `comprehension_question`.
 *
 * Lazily generated on the first check click (mirrors the lazy-gloss decision):
 * ONE provider call produces all questions, written in one transaction so a
 * junk response caches nothing. Questions are disposable derived data — no
 * manual tier; the recourse for bad questions is regenerateComprehensionCheck.
 * The answer key is part of the cached question; grading happens client-side
 * and learner responses are never persisted (roadmap).
 */
export async function getComprehensionCheck(
  db: DB,
  textId: number,
  provider: GlossProvider = getGlossProvider(),
): Promise<ComprehensionCheck> {
  const existing = db
    .select()
    .from(comprehensionQuestion)
    .where(eq(comprehensionQuestion.textId, textId))
    .orderBy(asc(comprehensionQuestion.questionIndex))
    .all()
  if (existing.length > 0) {
    return {
      questions: existing.map((q) => ({
        question: q.question,
        choices: q.choices,
        correctIndex: q.correctIndex,
      })),
      cached: true,
    }
  }

  const [text] = db
    .select()
    .from(sourceText)
    .where(eq(sourceText.id, textId))
    .all()
  if (!text) throw new Error(`text ${textId} not found`)

  if (!provider.comprehension) {
    throw new Error(`provider "${provider.name}" does not support comprehension checks`)
  }

  let result: Awaited<ReturnType<NonNullable<GlossProvider['comprehension']>>>
  try {
    result = await provider.comprehension({ text: text.content })
  } catch (err) {
    // Log server-side (the pnpm dev terminal) — the error otherwise only
    // surfaces as the UI's generic "failed" state, hiding the real cause
    // (e.g. `claude exited 1: 401 Invalid authentication credentials`).
    console.error(
      `[comprehension] provider "${provider.name}" failed for text ${textId}:`,
      err,
    )
    throw err
  }

  // onConflictDoNothing: concurrent first clicks (e.g. React StrictMode's
  // doubled effect) both generate; the first writer wins, the loser's rows
  // are dropped instead of violating the unique index.
  db.transaction((tx) => {
    result.questions.forEach((q, i) => {
      tx.insert(comprehensionQuestion)
        .values({
          textId,
          questionIndex: i,
          question: q.question,
          choices: q.choices,
          correctIndex: q.correctIndex,
          provider: provider.name,
        })
        .onConflictDoNothing()
        .run()
    })
  })

  // Re-read so a racing insert's value wins deterministically.
  const rows = db
    .select()
    .from(comprehensionQuestion)
    .where(eq(comprehensionQuestion.textId, textId))
    .orderBy(asc(comprehensionQuestion.questionIndex))
    .all()
  return {
    questions: rows.map((q) => ({
      question: q.question,
      choices: q.choices,
      correctIndex: q.correctIndex,
    })),
    cached: false,
  }
}

/**
 * Discard ALL cached questions for the text and generate fresh — the explicit
 * user "regenerate" recourse for bad questions (wrong key, ambiguous
 * distractors).
 */
export async function regenerateComprehensionCheck(
  db: DB,
  textId: number,
  provider: GlossProvider = getGlossProvider(),
): Promise<ComprehensionCheck> {
  db.delete(comprehensionQuestion)
    .where(eq(comprehensionQuestion.textId, textId))
    .run()
  return getComprehensionCheck(db, textId, provider)
}
