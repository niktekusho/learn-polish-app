import { expect, test } from 'vitest'
import { Rating } from '#/fsrs/index'
import { recognitionMcq } from './recognition-mcq'
import type { ExerciseCandidate } from './types'

const target: ExerciseCandidate = {
  lemmaId: 1,
  lemma: 'kot',
  pos: 'NOUN',
  gloss: 'gatto',
}
const pool: ExerciseCandidate[] = [
  target,
  { lemmaId: 2, lemma: 'pies', pos: 'NOUN', gloss: 'cane' },
  { lemmaId: 3, lemma: 'dom', pos: 'NOUN', gloss: 'casa' },
  { lemmaId: 4, lemma: 'woda', pos: 'NOUN', gloss: 'acqua' },
  { lemmaId: 5, lemma: 'chleb', pos: 'NOUN', gloss: 'pane' },
]

test('generate builds a 4-choice item with exactly one correct answer', () => {
  const item = recognitionMcq.generate(target, pool)
  expect(item).not.toBeNull()
  if (!item) return
  expect(item.id).toBeTruthy()
  expect(item.prompt).toBe('kot')
  expect(item.choices).toHaveLength(4)
  expect(new Set(item.choices).size).toBe(4)
  expect(item.choices[item.correctIndex]).toBe('gatto')
  expect(item.choices.filter((c) => c === 'gatto')).toHaveLength(1)
})

test('the client projection carries no correct-answer marker', () => {
  const item = recognitionMcq.generate(target, pool)
  if (!item) throw new Error('no item')
  const client = recognitionMcq.toClient(item)
  expect(client).toEqual({
    id: item.id,
    prompt: item.prompt,
    choices: item.choices,
  })
  expect('correctIndex' in client).toBe(false)
  expect('lemmaId' in client).toBe(false)
})

test('appliesTo requires a gloss', () => {
  expect(recognitionMcq.appliesTo(target)).toBe(true)
  expect(recognitionMcq.appliesTo({ lemmaId: 9, lemma: 'x', pos: 'NOUN' })).toBe(
    false,
  )
})

test('generate returns null without enough distractors', () => {
  const thin = [target, { lemmaId: 2, lemma: 'pies', pos: 'NOUN', gloss: 'cane' }]
  expect(recognitionMcq.generate(target, thin)).toBeNull()
})

test('grade maps correct/incorrect to a valid FSRS rating', () => {
  const item = recognitionMcq.generate(target, pool)
  if (!item) throw new Error('no item')

  const right = recognitionMcq.grade(item, { choiceIndex: item.correctIndex })
  const wrong = recognitionMcq.grade(item, {
    choiceIndex: (item.correctIndex + 1) % 4,
  })
  expect(right).toBe(Rating.Good)
  expect(wrong).toBe(Rating.Again)
  for (const r of [right, wrong]) {
    expect(r).toBeGreaterThanOrEqual(Rating.Again)
    expect(r).toBeLessThanOrEqual(Rating.Easy)
  }
})
