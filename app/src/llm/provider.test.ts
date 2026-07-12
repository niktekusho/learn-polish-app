import { expect, test } from 'vitest'
import { buildSenseGlossPrompt, parseSenseGlossJson } from './provider'

const good = JSON.stringify({
  translations: [
    { index: 0, italian: 'castello' },
    { index: 1, italian: 'serratura' },
  ],
  bestIndex: 1,
})

test('parses plain JSON', () => {
  const res = parseSenseGlossJson(good, 2)
  expect(res.bestIndex).toBe(1)
  expect(res.translations).toHaveLength(2)
})

test('strips markdown fences', () => {
  const fenced = '```json\n' + good + '\n```'
  expect(parseSenseGlossJson(fenced, 2).bestIndex).toBe(1)
})

test('throws on out-of-range translation index', () => {
  expect(() => parseSenseGlossJson(good, 1)).toThrow(/out of range/)
})

test('throws when bestIndex is not among translations', () => {
  const bad = JSON.stringify({
    translations: [{ index: 0, italian: 'castello' }],
    bestIndex: 3,
  })
  expect(() => parseSenseGlossJson(bad, 5)).toThrow(/not among/)
})

test('throws on junk output', () => {
  expect(() => parseSenseGlossJson('Ecco la traduzione: ...', 2)).toThrow(/not JSON/)
  expect(() => parseSenseGlossJson('{"translations":[]}', 2)).toThrow()
})

test('prompt lists senses with their indexes and demands JSON', () => {
  const prompt = buildSenseGlossPrompt({
    lemma: 'zamek',
    pos: 'NOUN',
    sentence: 'Zamek w drzwiach.',
    senses: [
      { index: 0, gloss: 'castle' },
      { index: 1, gloss: 'lock' },
    ],
  })
  expect(prompt).toContain('0. castle')
  expect(prompt).toContain('1. lock')
  expect(prompt).toContain('bestIndex')
})
