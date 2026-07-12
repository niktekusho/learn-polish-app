import { eq } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type * as schema from '#/db/schema'
import { dictEntry } from '#/db/schema'

type DB = BetterSQLite3Database<typeof schema>

// Contiguous MWE detection at import time (roadmap: v1 scope). Matches runs
// of tokens against the home dictionary's multi-word headwords. Surface
// match covers invariable MWEs (na pewno); lemma match gives partial
// coverage of inflecting ones (zdaję sobie sprawę -> zdawać sobie sprawę).
// ponytail: word-order variants and discontinuous MWEs don't match — parked.

export interface MweToken {
  surface: string
  lemma: string | null
  position: number
  sentenceIndex: number
  isSpace: boolean
}

export interface MweMatch {
  headword: string
  startPosition: number
  endPosition: number
  sentenceIndex: number
}

/** All multi-word headwords, keyed by lowercased first word. */
export function loadMweHeadwords(db: DB): Map<string, string[]> {
  const map = new Map<string, string[]>()
  const rows = db
    .selectDistinct({ word: dictEntry.word })
    .from(dictEntry)
    .where(eq(dictEntry.isMwe, true))
    .all()
  for (const { word } of rows) {
    const first = word.split(' ')[0].toLowerCase()
    const list = map.get(first)
    if (list) list.push(word)
    else map.set(first, [word])
  }
  return map
}

/**
 * Find contiguous MWE occurrences. Per sentence, at each word token the
 * candidates are the headwords starting with that token's surface or lemma;
 * every headword word must then equal the surface or lemma of the following
 * tokens (case-insensitive). Longest match wins; matches never overlap.
 */
export function detectMwes(
  tokens: MweToken[],
  headwords: Map<string, string[]>,
): MweMatch[] {
  const matches: MweMatch[] = []
  if (headwords.size === 0) return matches

  // Group word tokens per sentence, preserving order.
  const sentences = new Map<number, MweToken[]>()
  for (const t of tokens) {
    if (t.isSpace) continue
    const list = sentences.get(t.sentenceIndex)
    if (list) list.push(t)
    else sentences.set(t.sentenceIndex, [t])
  }

  const tokenMatches = (t: MweToken, word: string) =>
    t.surface.toLowerCase() === word || t.lemma?.toLowerCase() === word

  for (const [sentenceIndex, sent] of sentences) {
    let i = 0
    while (i < sent.length) {
      const t = sent[i]
      const candidates = new Set<string>([
        ...(headwords.get(t.surface.toLowerCase()) ?? []),
        ...(t.lemma ? (headwords.get(t.lemma.toLowerCase()) ?? []) : []),
      ])
      let bestLen = 0
      let bestHeadword: string | null = null
      for (const headword of candidates) {
        const words = headword.toLowerCase().split(' ')
        if (words.length <= bestLen || i + words.length > sent.length) continue
        if (words.every((w, k) => tokenMatches(sent[i + k], w))) {
          bestLen = words.length
          bestHeadword = headword
        }
      }
      if (bestHeadword) {
        matches.push({
          headword: bestHeadword,
          startPosition: sent[i].position,
          endPosition: sent[i + bestLen - 1].position,
          sentenceIndex,
        })
        i += bestLen // no overlaps
      } else {
        i++
      }
    }
  }
  return matches
}
