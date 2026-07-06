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

## DONE - #2 — Morphology sidecar: analyze Polish text

**Blocked by:** #1
**Deliver:** the Python seam that turns raw text into lemmas.

- `POST /analyze` takes Polish text, returns tokens with `{surface, lemma, pos, tags}` using
  spaCy `pl_core_news_*` (or Morfeusz2).
- Sentence boundaries preserved (needed later for cloze/context).
- Ambiguity: return the analyzer's best single lemma per token for now (disambiguation parked).

**Acceptance:** posting _"Robię obiad w kuchni."_ returns lemmas _robić, obiad, w, kuchnia_
with correct POS. See [ADR-0001](./adr/0001-typescript-app-with-python-morphology-sidecar.md).

---

## DONE - #3 — DB schema: texts, tokens, lemmas, knowledge, glosses

**Blocked by:** #1
**Deliver:** the vocab store shape.

- Tables: `text` (imported document), `token` (surface + position + link to lemma + text),
  `lemma` (base form, POS), `knowledge` (per-lemma FSRS state, **receptive** and
  **productive** tracks), `gloss` (lemma/sense → Italian, cached).
- FSRS fields on `knowledge` per track: stability, difficulty, due, last_review, state.
- `review_log`: append-only history of every grade (lemma, track, rating, state
  before/after, reviewed_at). Required from day 1 — FSRS parameter optimization needs the
  full review history and it cannot be reconstructed later.
- `gloss.provider` (or `source`) column: which provider produced the gloss (stub, ollama,
  api). Without it, stub glosses cached during development are indistinguishable from real
  ones and can never be purged.
- Indexes for "due lemmas" query and "lemma by surface form" lookup.

**Acceptance:** schema migrates clean; can insert a lemma with two independent track states;
grading writes a `review_log` row. Implements the model in [CONTEXT.md](../CONTEXT.md).

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
- Sentence context is **mandatory** for generation: never generate-and-cache a gloss with
  empty context (a context-free gloss written to the cache becomes *the* gloss for that
  lemma forever, defeating the disambiguation design). Callers without a sentence read the
  cache only.
- Cache rows record their provider (see #3) so stub output can be found and purged when a
  real provider lands.
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
  **Excludes** lemmas the user explicitly marked "still learning" (state Learning /
  Relearning) — the batch must not overwrite an explicit judgment with Easy.
- Marking updates highlight state live. Whether a word counts as "known" is decided
  server-side (one rule), not by comparing raw FSRS state enums in the UI.

**Acceptance:** marking a word known removes its highlight and sets a receptive FSRS state
with a future due date; batch-mark clears all visible unknowns at once.

---

## #8 — FSRS integration (`ts-fsrs`)

**Blocked by:** #3
**Deliver:** the scheduling brain.

- Wrap `ts-fsrs`: given a `knowledge` track state + a rating, return the next state (stability,
  difficulty, due).
- "Due lemmas" query: fetch lemmas whose receptive (or productive) track is due, weakest first —
  **but new-card introduction is gated**. Import makes every lemma due immediately with
  stability 0, so a naive weakest-first order lets one pasted article bury genuine reviews
  indefinitely. Rule: actual reviews (state ≠ New) come first, then at most a capped number
  of New cards per session (e.g. 10).
- Grade→update helper both #7 and #10 call. Every grade appends a `review_log` row (#3) in
  the same transaction as the state update.

**Acceptance:** rating a lemma advances its FSRS state deterministically and logs the review;
the due-query returns due reviews before New cards and never returns more than the New-card
cap. Implements the FSRS model in
[ADR-0003](./adr/0003-srs-driven-sessions-with-exercise-plugins.md).

---

## #9 — Exercise plugin contract + recognition-MCQ exercise

**Blocked by:** #3, #6
**Deliver:** the first exercise behind the extensible contract.

- Define the `Exercise` contract from ADR-0003 (`tracks`, `appliesTo`, `generate`, `grade`,
  `modality`) as shared types.
- Implement **recognition-MCQ**: prompt = Polish lemma; choices = its Italian gloss + 3
  distractor glosses from other lemmas; trains the **receptive** track.
- `grade` maps correct/incorrect → an FSRS rating, and runs **server-side against a
  server-held item**: the client submits only its choice (by item id), never the item or
  `correctIndex` back. The contract must not require round-tripping grade material through
  the client — the next exercise will copy whatever shape this one sets.
- Server functions validate their input (real validators, not identity passthroughs).

**Acceptance:** given a due lemma with a cached gloss, the exercise generates a 4-choice item
with exactly one correct answer; grading a response returns a valid FSRS rating; the payload
sent to the client contains no correct-answer marker.

---

## #10 — Practice queue (SRS-driven session)

**Blocked by:** #8, #9
**Deliver:** the daily loop, end to end.

- "Practice" screen: scheduler pulls due lemmas (reviews first, capped New cards — #8),
  renders each through an applicable exercise (only recognition-MCQ exists yet), collects the
  response, grades via #8.
- Session is built once and held server-side (id → items): a page reload/refocus resumes it
  instead of re-running the scheduler mid-session; grading an item twice is rejected.
- **No gloss generation inside session build.** Practice has no sentence context (#6 rule);
  lemmas without a cached gloss are skipped — glosses come from reading. No LLM calls in a
  route loader.
- Session ends when the due queue is exhausted or a cap is hit; show a brief summary.

**Acceptance:** starting Practice presents due lemmas as MCQ items one by one; answering
updates each lemma's FSRS state exactly once per item; a session makes zero LLM calls;
finishing shows how many were reviewed. This closes the tracer bullet. Implements
[ADR-0003](./adr/0003-srs-driven-sessions-with-exercise-plugins.md).

---

### Nits from design review (fold into whichever issue touches the file)

- DB path is `process.cwd()`-relative — starting the server from repo root vs `app/`
  silently creates two databases. Make it absolute or env-configured.
- `gradeLemma`'s read-then-write should run in one transaction; batch-mark should be one
  transaction, not N.
- CONTEXT.md's "tracked unit = lemma + surface forms encountered" is only derivable by
  scanning `token` — fine for MVP, but the gap is deliberate; note it, don't model it yet.

### Suggested grab order

`#1 → #2, #3 (parallel) → #4 → #5 → #6, #8 (parallel) → #7, #9 → #10`

### Parked (post-MVP, do not pull into these issues)

Speaking/ASR + TTS, listening dictation, grammar drills (case/aspect/gender/conjugation),
URL + `.srt`/`.epub`/YouTube importers, native audio (v2), frequency-onboarding UI, kaikki
bulk import + top-5k gloss seeding, tier-3 accent scoring, IPA pronunciation exercises,
word-sense disambiguation.
