import { State } from 'ts-fsrs'

/**
 * The single rules for interpreting a lemma's receptive knowledge state,
 * decided server-side — the reader UI must not compare raw FSRS state enums
 * itself (backlog #7). #5 highlights on `known`; #7 uses `stillLearning` to
 * keep batch-mark from overwriting an explicit judgment.
 */
export function isReceptiveKnown(state: number | null | undefined): boolean {
  return state === State.Review
}

/** The user has explicitly touched this word but hasn't learned it yet. */
export function isStillLearning(state: number | null | undefined): boolean {
  return state === State.Learning || state === State.Relearning
}

/** The verdicts the reader UI renders from (booleans, never raw enums). */
export function knowledgeFlags(state: number | null | undefined) {
  return { known: isReceptiveKnown(state), stillLearning: isStillLearning(state) }
}
