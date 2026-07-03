# SRS-driven sessions with exercise plugins

## Context

The app must support many varied exercise types (reading, listening, case drills, aspect,
gender, conjugation, translation, speaking) over a shared vocab store, and must decide
*what* the learner practices. We separate the two concerns: selection vs. rendering.

## Decision

**Selection is SRS-driven.** The default daily loop, **Practice**, is a mixed queue: the
FSRS scheduler pulls **due lemmas** (weakest track first — see the receptive/productive
split in CONTEXT.md) and renders each through an applicable exercise. Variety emerges from
the mix; the learner reviews what is actually decaying, not a menu they picked. A secondary
**Focused drill** mode lets the learner select one exercise type explicitly, using the same
components with a different selection query.

**Rendering is pluggable.** Every exercise implements one contract and nothing else knows
its specifics:

```ts
Exercise {
  id
  tracks: ("receptive" | "productive")[]   // which memory track it trains
  appliesTo(lemma, dict): boolean           // e.g. gender-sort → nouns only
  generate(lemmas, dict): Item              // prompt, choices / expected answer
  grade(item, response): Rating             // → FSRS update on the track(s)
  modality: { prompt: text | audio, answer: tap | choice | speak }
}
```

The scheduler and the session UI depend only on this contract. Adding an exercise type is
adding a plugin; the vocab store, scheduler, and FSRS logic are untouched.

## Consequences

- The scheduler must know each exercise's `tracks` and `appliesTo` to build a valid queue
  (don't hand a verb-only drill a noun).
- Because rendering is decoupled from selection, the same lemma can be practiced through
  different exercises on different days, which is the intended variety.
