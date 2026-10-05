# Pronunciation is a separate knowledge track

Speaking exercises let the learner retry until the ASR hears the word, and we want how
often a word needs retries to decide when it comes back. That signal is about *saying*
a word, which is neither understanding it (Receptive) nor recalling it (Productive), so
we added a third FSRS track, **Pronunciation**, rather than folding retries into the
existing two. Its FSRS difficulty *is* the "how hard is this word to say" score, and its
due date is when the word is proposed for speaking again.

Only **Visible attempts** grade it: every Read-aloud attempt, and Spoken recall retries
after the answer is revealed. Read-aloud therefore stops grading Receptive, and Spoken
recall grades Productive only from the attempt before the reveal (or the learner's
self-grade of it). This also closes a hole where a post-reveal retry counted as a
successful recall. A lemma gets a Pronunciation card only after its first Receptive
review (understand, then say, then recall). Extends ADR-0003's track model.

## Considered options

- **Fold retries into existing ratings** (retry → Hard on Receptive for Read-aloud,
  on Productive for Spoken recall): least code, but an ASR stumble on a word you
  understand would mark it as not understood — the track separation in CONTEXT.md
  exists precisely to keep these apart.
- **A separate home-made difficulty score** outside FSRS: duplicates what FSRS
  difficulty already models, and would need its own scheduling logic.

## Consequences

- Past Read-aloud grades stay on Receptive: `review_log` does not record which
  exercise produced a grade, so they cannot be migrated. Pronunciation starts empty.
- Practice now balances three queues (equal shares, interleaved) instead of serving
  the weakest track first; with the mic off, only Receptive takes part.
- One Spoken recall item can write two tracks (Productive, and Pronunciation if the
  learner retried after the reveal).
