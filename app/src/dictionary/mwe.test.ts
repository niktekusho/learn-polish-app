import { expect, test } from 'vitest'
import { detectMwes, type MweToken } from './mwe'

function tok(
  surface: string,
  lemma: string | null,
  position: number,
  sentenceIndex = 0,
): MweToken {
  return { surface, lemma, position, sentenceIndex, isSpace: false }
}

function headwords(...words: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const w of words) {
    const first = w.split(' ')[0].toLowerCase()
    map.set(first, [...(map.get(first) ?? []), w])
  }
  return map
}

test('bigram surface match (na pewno)', () => {
  const tokens = [tok('Na', 'na', 0), tok('pewno', 'pewno', 1), tok('tak', 'tak', 2)]
  const matches = detectMwes(tokens, headwords('na pewno'))
  expect(matches).toEqual([
    { headword: 'na pewno', startPosition: 0, endPosition: 1, sentenceIndex: 0 },
  ])
})

test('lemma-based match covers inflected components', () => {
  // "zdaję sobie sprawę" -> headword "zdawać sobie sprawę" via lemmas.
  const tokens = [
    tok('Zdaję', 'zdawać', 0),
    tok('sobie', 'sobie', 1),
    tok('sprawę', 'sprawa', 2),
  ]
  const matches = detectMwes(tokens, headwords('zdawać sobie sprawę'))
  expect(matches).toHaveLength(1)
  expect(matches[0].headword).toBe('zdawać sobie sprawę')
  expect(matches[0].endPosition).toBe(2)
})

test('longest match wins at the same start', () => {
  const tokens = [tok('na', 'na', 0), tok('pewno', 'pewno', 1), tok('nie', 'nie', 2)]
  const matches = detectMwes(tokens, headwords('na pewno', 'na pewno nie'))
  expect(matches).toEqual([
    {
      headword: 'na pewno nie',
      startPosition: 0,
      endPosition: 2,
      sentenceIndex: 0,
    },
  ])
})

test('no match across sentence boundary', () => {
  const tokens = [tok('na', 'na', 0, 0), tok('pewno', 'pewno', 1, 1)]
  expect(detectMwes(tokens, headwords('na pewno'))).toEqual([])
})

test('matches never overlap; scan continues after a match', () => {
  const tokens = [
    tok('na', 'na', 0),
    tok('pewno', 'pewno', 1),
    tok('na', 'na', 2),
    tok('pewno', 'pewno', 3),
  ]
  const matches = detectMwes(tokens, headwords('na pewno'))
  expect(matches).toHaveLength(2)
  expect(matches[1].startPosition).toBe(2)
})

test('space tokens and empty headword map are ignored', () => {
  const tokens = [
    tok('na', 'na', 0),
    { surface: ' ', lemma: null, position: 1, sentenceIndex: 0, isSpace: true },
    tok('pewno', 'pewno', 2),
  ]
  // Space tokens are skipped -> na/pewno are adjacent in the word sequence.
  expect(detectMwes(tokens, headwords('na pewno'))).toHaveLength(1)
  expect(detectMwes(tokens, new Map())).toEqual([])
})
