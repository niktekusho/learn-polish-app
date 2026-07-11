import { expect, test } from 'vitest'
import { ClaudeCliGlossProvider, parseGloss } from './claude-cli'

const req = { lemma: 'robić', pos: 'VERB', sentence: 'Robię obiad w kuchni.' }

test('parseGloss trims a valid one-liner', () => {
  expect(parseGloss('  fare\n')).toBe('fare')
})

test('parseGloss rejects empty output', () => {
  expect(() => parseGloss('   \n')).toThrow()
})

test('parseGloss rejects a rambling response (too long)', () => {
  expect(() => parseGloss('Ecco la glossa: '.repeat(10))).toThrow()
})

test('provider returns the parsed CLI stdout', async () => {
  const provider = new ClaudeCliGlossProvider(async () => 'fare\n')
  expect(await provider.gloss(req)).toBe('fare')
})

test('provider bubbles a CLI failure so nothing gets cached', async () => {
  const provider = new ClaudeCliGlossProvider(async () => {
    throw new Error('claude exited 1')
  })
  await expect(provider.gloss(req)).rejects.toThrow()
})
