# MVP Backlog — Tracer-Bullet Slice

Goal of the MVP: prove the whole architecture once, end to end —
**paste text → morphology sidecar → vocab store → reader + gloss → FSRS receptive →
recognition-MCQ via the Practice queue.**

Everything in the "Parked" list of the design session is out of scope here. See
[CONTEXT.md](../CONTEXT.md) and [ADRs](./adr/) for the decisions these issues implement.

Dependency order is roughly top-to-bottom. Each issue names its blockers so it can be
grabbed independently once those are done.

---

## DONE - #1 — Repo scaffold: TanStack Start + SQLite + Python sidecar skeleton

**Blocked by:** none
**Deliver:** a running dev environment.

- TanStack Start app boots on localhost.
- SQLite wired (chosen driver, e.g. `better-sqlite3` or `libsql`), migrations runnable.
- Python sidecar skeleton: FastAPI app with a `/health` endpoint, documented `run` command.
- One command (or documented pair) starts app + sidecar together.

**Acceptance:** `GET /health` on the sidecar returns 200; app home route renders; a trivial
migration creates and reads a row.

---

## #2 — Morphology sidecar: analyze Polish text

**Blocked by:** #1
**Deliver:** the Python seam that turns raw text into lemmas.

- `POST /analyze` takes Polish text, returns tokens with `{surface, lemma, pos, tags}` using
  spaCy `pl_core_news_*` (or Morfeusz2).
- Sentence boundaries preserved (needed later for cloze/context).
- Ambiguity: return the analyzer's best single lemma per token for now (disambiguation parked).

**Acceptance:** posting _"Robię obiad w kuchni."_ returns lemmas _robić, obiad, w, kuchnia_
with correct POS. See [ADR-0001](./adr/0001-typescript-app-with-python-morphology-sidecar.md).

---

## #3 — DB schema: texts, tokens, lemmas, knowledge, glosses

**Blocked by:** #1
**Deliver:** the vocab store shape.

- Tables: `text` (imported document), `token` (surface + position + link to lemma + text),
  `lemma` (base form, POS), `knowledge` (per-lemma FSRS state, **receptive** and
  **productive** tracks), `gloss` (lemma/sense → Italian, cached).
- FSRS fields on `knowledge` per track: stability, difficulty, due, last_review, state.
- Indexes for "due lemmas" query and "lemma by surface form" lookup.

**Acceptance:** schema migrates clean; can insert a lemma with two independent track states.
Implements the model in [CONTEXT.md](../CONTEXT.md).

---

## #4 — Import + analyze pipeline (paste text)

**Blocked by:** #2, #3
**Deliver:** paste → stored, analyzed text.

- UI: paste raw Polish text, submit.
- Server: call sidecar `/analyze`, persist `text` + `token`s, upsert `lemma`s, create
  `knowledge` rows (default "new"/unknown) for lemmas not seen before.
- Idempotent-ish: re-importing links to existing lemmas, doesn't duplicate them.

**Acceptance:** pasting a paragraph creates one `text`, N `token`s, and the distinct lemmas
appear in the store each with a `knowledge` row.

---

## #5 — Reader UI: render text, highlight unknown lemmas

**Blocked by:** #4
**Deliver:** the reading surface.

- Render the imported text token-by-token, preserving layout.
- Lemmas whose receptive knowledge is "new/unknown" are visually highlighted; known ones plain.
- Clicking a token opens a word panel (content filled by #6).

**Acceptance:** an imported text shows highlighted unknowns; clicking a word opens the panel;
known words are not highlighted.

---

## #6 — Word panel: Italian gloss (LLM, cached) + Wiktionary link

**Blocked by:** #5, #3
**Deliver:** meaning on demand.

- On first lookup of a lemma, generate an Italian **gloss** via LLM using the sentence as
  context; cache in `gloss`. Subsequent lookups read cache (no LLM call).
- Panel shows: surface form, lemma, POS, Italian gloss, external link
  `https://en.wiktionary.org/wiki/{lemma}#Polish` (Diki link optional).
- LLM provider behind a small interface (local Ollama or API — swappable).

**Acceptance:** clicking an unknown word shows an Italian gloss within one call; clicking it
again makes zero LLM calls (served from cache). Implements
[ADR-0002](./adr/0002-dictionary-and-gloss-data-strategy.md) (lazy wave only; kaikki bulk
import + top-5k seeding parked).

---

## #7 — Mark known / batch-mark → FSRS receptive

**Blocked by:** #5, #8
**Deliver:** knowledge input from reading.

- Word panel: "mark known" and "still learning" actions → update receptive FSRS state.
- Batch action in reader: "mark all visible unknowns as known" to burn trivial words.
- Marking updates highlight state live.

**Acceptance:** marking a word known removes its highlight and sets a receptive FSRS state
with a future due date; batch-mark clears all visible unknowns at once.

---

## #8 — FSRS integration (`ts-fsrs`)

**Blocked by:** #3
**Deliver:** the scheduling brain.

- Wrap `ts-fsrs`: given a `knowledge` track state + a rating, return the next state (stability,
  difficulty, due).
- "Due lemmas" query: fetch lemmas whose receptive (or productive) track is due, weakest first.
- Grade→update helper both #7 and #10 call.

**Acceptance:** rating a lemma advances its FSRS state deterministically; the due-query returns
lemmas ordered by urgency. Implements the FSRS model in
[ADR-0003](./adr/0003-srs-driven-sessions-with-exercise-plugins.md).

---

## #9 — Exercise plugin contract + recognition-MCQ exercise

**Blocked by:** #3, #6
**Deliver:** the first exercise behind the extensible contract.

- Define the `Exercise` contract from ADR-0003 (`tracks`, `appliesTo`, `generate`, `grade`,
  `modality`) as shared types.
- Implement **recognition-MCQ**: prompt = Polish lemma; choices = its Italian gloss + 3
  distractor glosses from other lemmas; trains the **receptive** track.
- `grade` maps correct/incorrect → an FSRS rating.

**Acceptance:** given a due lemma with a cached gloss, the exercise generates a 4-choice item
with exactly one correct answer; grading a response returns a valid FSRS rating.

---

## #10 — Practice queue (SRS-driven session)

**Blocked by:** #8, #9
**Deliver:** the daily loop, end to end.

- "Practice" screen: scheduler pulls due lemmas (weakest track first), renders each through an
  applicable exercise (only recognition-MCQ exists yet), collects the response, grades via #8.
- Session ends when the due queue is exhausted or a cap is hit; show a brief summary.

**Acceptance:** starting Practice presents due lemmas as MCQ items one by one; answering
updates each lemma's FSRS state; finishing shows how many were reviewed. This closes the
tracer bullet. Implements [ADR-0003](./adr/0003-srs-driven-sessions-with-exercise-plugins.md).

---

### Suggested grab order

`#1 → #2, #3 (parallel) → #4 → #5 → #6, #8 (parallel) → #7, #9 → #10`

### Parked (post-MVP, do not pull into these issues)

Speaking/ASR + TTS, listening dictation, grammar drills (case/aspect/gender/conjugation),
URL + `.srt`/`.epub`/YouTube importers, native audio (v2), frequency-onboarding UI, kaikki
bulk import + top-5k gloss seeding, tier-3 accent scoring, IPA pronunciation exercises,
word-sense disambiguation.
