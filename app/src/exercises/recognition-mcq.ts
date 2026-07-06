import { Rating } from '#/fsrs/index'
import type { Exercise } from './types'

/** Full item, held server-side. Carries the answer — never sent to the client. */
export interface McqItem {
  id: string
  lemmaId: number
  prompt: string // the Polish lemma
  choices: string[] // 4 Italian glosses, one correct
  correctIndex: number
}
/** The answer-free projection the browser receives. */
export interface McqClientItem {
  id: string
  prompt: string
  choices: string[]
}
export interface McqResponse {
  choiceIndex: number
}

const DISTRACTORS = 3

type Rng = () => number

function shuffle<T>(arr: T[], rng: Rng): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Recognition MCQ (#9): prompt is a Polish lemma, choices are its Italian gloss
 * plus 3 distractor glosses from other lemmas. Trains the receptive track.
 */
export const recognitionMcq: Exercise<McqItem, McqClientItem, McqResponse> = {
  id: 'recognition-mcq',
  tracks: ['receptive'],
  modality: { prompt: 'text', answer: 'choice' },

  appliesTo: (c) => typeof c.gloss === 'string' && c.gloss.length > 0,

  generate(target, pool, rng: Rng = Math.random): McqItem | null {
    if (!target.gloss) return null

    // Distractors: other lemmas' glosses, de-duplicated and never equal to the
    // correct answer (so exactly one choice is right).
    const seen = new Set<string>([target.gloss])
    const distractors: string[] = []
    for (const c of shuffle(pool, rng)) {
      if (c.lemmaId === target.lemmaId || !c.gloss || seen.has(c.gloss)) continue
      seen.add(c.gloss)
      distractors.push(c.gloss)
      if (distractors.length === DISTRACTORS) break
    }
    if (distractors.length < DISTRACTORS) return null

    const choices = shuffle([target.gloss, ...distractors], rng)
    return {
      id: crypto.randomUUID(),
      lemmaId: target.lemmaId,
      prompt: target.lemma,
      choices,
      correctIndex: choices.indexOf(target.gloss),
    }
  },

  toClient: (item) => ({
    id: item.id,
    prompt: item.prompt,
    choices: item.choices,
  }),

  grade: (item, response) =>
    response.choiceIndex === item.correctIndex ? Rating.Good : Rating.Again,
}
