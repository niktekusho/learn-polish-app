# Post-MVP Roadmap

Governing principle (decided 2026-07-11): the app is a **daily driver with no finish
line**. "Final" means it carries the complete daily Polish routine — read, practice,
speak, listen. Slices are ordered by what unblocks real daily use; parked items return
only when dogfooding demands them.

Learner profile that shaped this ordering: grammar-strong (verb tenses known), vocabulary
below A1. So vocabulary acquisition and audio skills rank high; grammar drills rank low.

---

## Slice 0 — Dogfood (starts now, costs nothing)

Use the MVP daily: paste easy texts (children's books, learner blogs — manual paste, no
importers), read, run Practice. Real friction ranks everything below.

**Known watch item:** lazy per-click glossing means an LLM wait on nearly every first
click, since at sub-A1 most words in any text are unknown. Deliberately kept lazy for
now. If the first week hurts, the fix is **pre-gloss on import**: batch-generate glosses
for the text's unknown lemmas *with their sentence context* in the background at import
time. That respects the mandatory-context rule from MVP issue #6 and permanently kills
top-5k seeding (which has no sentence context and contradicts that rule).

## Slice 1 — Speaking (opens the productive track)

Sidecar gains a **faster-whisper** ASR endpoint (audio in → transcript out). See
[ADR-0004](./adr/0004-sidecar-hosts-asr-and-tts.md). Browser side: mic capture,
push-to-talk, upload; grading stays server-side per the MVP issue #9 pattern.

Two exercises share the audio infrastructure (terms in [CONTEXT.md](../CONTEXT.md)):

- **Spoken recall** — Italian gloss shown → say the Polish lemma. Grades the
  **productive** track (its first feeder). ASR transcript is lemma-matched against the
  target; because short non-native words are Whisper's weakest case, include a
  reveal-and-self-grade fallback for ASR misfires. Requires a cached gloss — same skip
  rule as recognition-MCQ, no LLM calls in session build.
- **Read-aloud** — Polish sentence shown, read it out loud. Grades **receptive only**:
  the word is on screen, so it proves decoding and pronunciation, not retrieval.
  (Decided explicitly to keep the productive track pure.)

## Slice 2 — Listening dictation

Sidecar gains a **Piper** TTS endpoint with audio caching (ADR-0004). Exercise: hear a
Polish word/sentence, type or choose what was heard. Grades receptive. First audio-input
training in the app — the listening half of the comprehension goal.

---

## Parked (revisit only on dogfooding signal)

- **Importers (URL / .srt / .epub / YouTube)** — manual paste chosen as the content
  strategy; importers rise only if daily copy-paste becomes the friction.
- **kaikki bulk import (home dictionary)** — needed only by grammar drills and a richer
  word panel. Note the hidden dependency: grammar drills can't start before this.
- **MWE tracking (multi-word expressions)** — decided (2026-07-11): MWEs are first-class
  Tracked units (see CONTEXT.md), but detection strategy is deferred until kaikki import
  lands — the dictionary's multi-word entries enable lookup-based detection (bigram match
  at tokenization), which beats both manual marking and LLM proposal as the first rung.
  v1 scope when picked up: contiguous MWEs only; discontinuous (*zdaję sobie z tego
  sprawę*) deferred further.
- **Grammar drills (case/aspect/gender/conjugation)** — learner is grammar-strong; low
  value today. Blocked by kaikki import.
- **LLM-generated graded texts** — new candidate from this session, not pursued: hard to
  give the model reliable cognition of the learner's level. Counterpoint for later: the
  FSRS store *is* a machine-readable known-lemma list, which is exactly that cognition.
- **Progress/stats view** — cheap filler slice, motivates the daily habit; slot in
  anytime.
- **Top-5k gloss seeding** — effectively dead: contradicts the mandatory-context gloss
  rule; superseded by pre-gloss-on-import if glossing latency ever hurts.
- **Frequency-onboarding UI** — effectively dead: at sub-A1 vocabulary there is nothing
  to batch-mark as known.
- **Word-sense disambiguation, accent scoring (tier-3), IPA exercises, native audio
  (v2)** — unchanged, still parked.
