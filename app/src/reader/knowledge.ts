import { State } from 'ts-fsrs'

/**
 * The single rule for whether a lemma's receptive knowledge counts as "known"
 * (FSRS State.Review). Decided here, server-side — the reader UI must not
 * compare raw FSRS state enums itself (backlog #7). #5 highlights, #7 reuses.
 */
export function isReceptiveKnown(state: number | null | undefined): boolean {
  return state === State.Review
}
