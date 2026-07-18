import { Rating } from '#/fsrs/index'
import type { SpokenResponse } from './spoken-recall'
import { transcriptMatches } from './spoken-recall'
import type { Exercise } from './types'

/**
 * Read-aloud (roadmap Slice 1): a sentence from the learner's own texts is on
 * screen; read it out loud. Grades **receptive only** — the word is visible,
 * so this proves decoding and pronunciation, never retrieval (the productive
 * track stays pure, see CONTEXT.md).
 *
 * Pass = the target lemma is heard in the transcript (target lemma only, one
 * FSRS write — grading every lemma in the sentence would punish words the
 * ASR merely garbled).
 */
export interface ReadAloudItem {
  id: string
  lemmaId: number
  lemma: string // the target being graded
  sentence: string
}
export interface ReadAloudClientItem {
  id: string
  kind: 'read-aloud'
  sentence: string
}

export const readAloud: Exercise<ReadAloudItem, ReadAloudClientItem, SpokenResponse> = {
  id: 'read-aloud',
  tracks: ['receptive'],
  modality: { prompt: 'text', answer: 'speak' },

  appliesTo: (c) => typeof c.sentence === 'string' && c.sentence.length > 0,

  generate(target) {
    if (!target.sentence) return null
    return {
      id: crypto.randomUUID(),
      lemmaId: target.lemmaId,
      lemma: target.lemma,
      sentence: target.sentence,
    }
  },

  // The sentence necessarily shows the target — nothing to strip beyond the
  // lemma field itself (keeps "which word is graded" server-side).
  toClient: (item) => ({
    id: item.id,
    kind: 'read-aloud',
    sentence: item.sentence,
  }),

  grade: (item, response) =>
    transcriptMatches(item.lemma, response) ? Rating.Good : Rating.Again,
}
