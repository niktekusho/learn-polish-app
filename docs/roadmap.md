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

## Comprehension checks (designed 2026-07-12, shipped 2026-07-12)

**Comprehension check** (term in [CONTEXT.md](../CONTEXT.md)): questions about a text,
answered after reading to verify understanding. NOT an Exercise — no FSRS write, no
scheduler involvement. Decisions:

- End-of-text explicit trigger (button) — also the app's first "I read this" signal.
- Italian MCQ, 3–4 choices; isolates text comprehension from question comprehension at
  sub-A1. Free text rejected (needs LLM grading); true/false rejected (guessable).
- LLM-generated lazily on first check click, cached in DB — mirrors the lazy-gloss
  decision, same escape hatch (move to import-time batch if the wait hurts).
- 1–10 questions per text, count proportional to text length, LLM picks within range
  (tiny paste ≈ 1–2, long text caps at 10). Not configurable.
- Cached questions are **disposable derived data** — no manual tier (unlike glosses),
  safe to regenerate or delete. Language switch later = regenerate; if variants ever
  coexist, cache key becomes (text, language, difficulty) via migration.
- Learner **responses** NOT persisted (the **answer key** is — it's part of the cached
  question; grading compares the clicked choice against it in-session). "4/5" toast, then
  forgotten. Stats slice can add a results table later if it wants comprehension history.
- Bad questions (wrong key, ambiguous distractors): recourse = per-text regenerate
  button, nukes cache. No per-question editing — throwaway data, not gloss-tier.

Future notes (explicitly wanted, not v1):

- **Polish questions** — once vocab grows, asking in Polish doubles as reading practice.
- **Difficulty selector** — depending on the text, let the learner pick question
  difficulty before generation.

---

## Parked (revisit only on dogfooding signal)

- **Importers (URL / .srt / .epub / YouTube)** — manual paste chosen as the content
  strategy; importers rise only if daily copy-paste becomes the friction.
- ~~**kaikki bulk import (home dictionary)**~~ — **shipped (2026-07-12)**: schema +
  streaming importer (maintenance page), word-panel reference (senses, IPA, forms,
  etymology), hybrid per-sense glosses, contiguous MWE detection. See ADR-0002
  "Amendment resolved".
- ~~**MWE tracking (multi-word expressions)**~~ — **v1 shipped (2026-07-12)**:
  contiguous lookup-based detection at import (dictionary multi-word headwords, surface
  or lemma match). Discontinuous MWEs (*zdaję sobie z tego sprawę*) stay parked.
- **Grammar drills (case/aspect/gender/conjugation)** — learner is grammar-strong; low
  value today. Now unblocked (`dict_form` has the inflection tables), still low priority.
- **Etymology-based games** — new idea (2026-07-12): `dict_entry.etymology` is now
  stored; explore exercises built on it (cognate guessing, Proto-Slavic roots,
  borrowing-language quizzes). Fun layer, not a knowledge-track feeder.
- **LLM-generated graded texts** — new candidate from this session, not pursued: hard to
  give the model reliable cognition of the learner's level. Counterpoint for later: the
  FSRS store *is* a machine-readable known-lemma list, which is exactly that cognition.
- **Progress/stats view** — cheap filler slice, motivates the daily habit; slot in
  anytime.
- **Top-5k gloss seeding** — effectively dead: contradicts the mandatory-context gloss
  rule; superseded by pre-gloss-on-import if glossing latency ever hurts.
- **Frequency-onboarding UI** — effectively dead: at sub-A1 vocabulary there is nothing
  to batch-mark as known.
- ~~**Per-sense glosses (context-dependent meanings)**~~ — **shipped (2026-07-12)**
  via the hybrid strategy (one call translates all senses + flags the context fit; see
  ADR-0002 "Amendment resolved"). The word panel now shows every sense with its Italian,
  so the *przedmiot*/"oggetto" trap is visible and fixable. Inline display is still
  first-pick-wins until WSD (below) is picked up.
- **Word-sense disambiguation, accent scoring (tier-3), IPA exercises, native audio
  (v2)** — unchanged, still parked. (WSD = auto-picking the right sense per occurrence;
  a later layer on top of per-sense glosses above.)
