# Lemma slips are wiped, not merged

A **Lemma slip** (_myśli_, _pracujesz_, _pieczywać_) often has a real twin that already has its own Knowledge state (_myśleć_, _pracować_). When a slip is repaired, its occurrences move to the twin and the slip is deleted with its Knowledge state, review log and glosses. Its state is never merged into the twin's. The state was earned on a non-word: Spoken recall asked for _pracujesz_ as if it were a lemma, so it is evidence about no real word. The twin keeps its own state, or starts as New when it did not exist. This settles the merge question #1 left open, and matches #6, which deletes non-dictionary lemmas the same way.

## Considered options

- **Merge per track, keeping the row with more reviews**: keeps practice history, but treats evidence about a non-word as evidence about the real one, and needs per-track merge rules plus a ruling on manual glosses.
- **Replay both review logs through FSRS into one state**: the most faithful merge, and the most machinery for a handful of rows.

## Consequences

- A repair cannot be undone: the deleted state and review log are gone. Repairs are confirmed by the Home dictionary alone (exactly one headword whose forms contain every surface of the slip), never by an LLM.
- A manual gloss on a slip is deleted with it.
