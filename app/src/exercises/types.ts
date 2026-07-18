import type { Grade, Track } from '#/fsrs/index'

export type { Track }
export type PromptModality = 'text' | 'audio'
export type AnswerModality = 'tap' | 'choice' | 'speak'
export interface Modality {
  prompt: PromptModality
  answer: AnswerModality
}

// The lemma-plus-reference view an exercise operates on. `gloss` is the cached
// Italian meaning when available (the "dict" side of ADR-0003's contract).
// `sentence` is a sentence from the user's imported texts containing the
// lemma — populated by the session builder only when a speaking exercise
// might use it (read-aloud).
export interface ExerciseCandidate {
  lemmaId: number
  lemma: string
  pos: string
  gloss?: string
  sentence?: string
}

/**
 * The one contract every exercise implements (ADR-0003). The scheduler (#10)
 * and session UI depend only on this — adding an exercise is adding a plugin.
 *
 * `Item` is the full server-held item (contains the answer). `ClientItem` is
 * what the browser sees — `toClient` MUST strip every correct-answer marker.
 * Grading happens server-side against the held `Item`; the client only ever
 * sends a `Response` referencing the item by id (#9). No grade material ever
 * round-trips through the client.
 */
export interface Exercise<Item, ClientItem, Response> {
  id: string
  tracks: Track[]
  modality: Modality
  /** Can this exercise be built for the candidate? (e.g. needs a gloss). */
  appliesTo(candidate: ExerciseCandidate): boolean
  /** Build a full item for `target`, drawing distractors etc. from `pool`. */
  generate(target: ExerciseCandidate, pool: ExerciseCandidate[]): Item | null
  /** Project the full item to the answer-free shape sent to the browser. */
  toClient(item: Item): ClientItem
  /** Map a response to an FSRS rating on this exercise's track(s). */
  grade(item: Item, response: Response): Grade
}
