import { expect, test } from 'vitest'
import {
  buildComprehensionPrompt,
  buildSenseGlossPrompt,
  parseComprehensionJson,
  parseSenseGlossJson,
} from './provider'

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

// --- Comprehension checks ----------------------------------------------------

const goodCheck = JSON.stringify({
  questions: [
    { question: 'Di cosa parla il testo?', choices: ['gatti', 'cani', 'case'], correctIndex: 0 },
  ],
})

test('comprehension: parses plain JSON and strips fences', () => {
  expect(parseComprehensionJson(goodCheck).questions).toHaveLength(1)
  const fenced = '```json\n' + goodCheck + '\n```'
  expect(parseComprehensionJson(fenced).questions[0].correctIndex).toBe(0)
})

test('comprehension: throws on junk, empty questions, bad choice counts', () => {
  expect(() => parseComprehensionJson('Ecco le domande: ...')).toThrow(/not JSON/)
  expect(() => parseComprehensionJson('{"questions":[]}')).toThrow()
  const twoChoices = JSON.stringify({
    questions: [{ question: 'Q?', choices: ['a', 'b'], correctIndex: 0 }],
  })
  expect(() => parseComprehensionJson(twoChoices)).toThrow()
  const fiveChoices = JSON.stringify({
    questions: [{ question: 'Q?', choices: ['a', 'b', 'c', 'd', 'e'], correctIndex: 0 }],
  })
  expect(() => parseComprehensionJson(fiveChoices)).toThrow()
})

test('comprehension: throws on more than 10 questions', () => {
  const many = JSON.stringify({
    questions: Array.from({ length: 11 }, (_, i) => ({
      question: `Q${i}?`,
      choices: ['a', 'b', 'c'],
      correctIndex: 0,
    })),
  })
  expect(() => parseComprehensionJson(many)).toThrow()
})

test('comprehension: throws on out-of-range correctIndex', () => {
  const bad = JSON.stringify({
    questions: [{ question: 'Q?', choices: ['a', 'b', 'c'], correctIndex: 3 }],
  })
  expect(() => parseComprehensionJson(bad)).toThrow(/out of range/)
})

test('comprehension: prompt embeds the text and demands JSON', () => {
  const prompt = buildComprehensionPrompt({ text: 'Ala ma kota.' })
  expect(prompt).toContain('Ala ma kota.')
  expect(prompt).toContain('correctIndex')
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
