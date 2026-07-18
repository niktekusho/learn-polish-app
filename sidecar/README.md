# Python ML sidecar

FastAPI service hosting the Python ML pieces the TS app calls over localhost HTTP:
morphology (spaCy `pl_core_news_sm`,
[ADR-0001](../docs/adr/0001-typescript-app-with-python-morphology-sidecar.md)) and ASR
(faster-whisper, [ADR-0004](../docs/adr/0004-sidecar-hosts-asr-and-tts.md)).

## Runtime

Pinned to **Python 3.13** via `.python-version` — spaCy ships no 3.14 wheels yet. `uv`
fetches the interpreter automatically, so no system Python is required.

```sh
uv sync                 # install deps (FastAPI, uvicorn, spaCy + pl_core_news_sm)
uv run uvicorn main:app --reload --port 8000
```

From the repo root, `pnpm dev` starts this alongside the app.

## Endpoints

- `GET /health` → `{"status": "ok", "asr_model": "small", "asr_loaded": false}`
- `POST /transcribe` — multipart field `audio` (any browser-recorded container:
  ogg/webm/mp4/wav; PyAV decodes) → `{"text": "..."}`. Polish-forced faster-whisper,
  `vad_filter` on (silence → empty text, not hallucinations). Model size via
  `WHISPER_MODEL` env var (default `medium`, int8 on CPU — beat `small` on accuracy at
  equal short-clip latency in the 2026-07-13 clip eval; `large-v3-turbo` was worse on
  Polish single words); lazy-loaded on first call —
  the first call ever also downloads the model from HuggingFace (~1.5GB). Returns the
  raw transcript only; callers wanting lemmas pipe the text through `/analyze`.
  Every call logs a `[transcribe]` line (bytes, duration, language probability,
  per-segment avg_logprob/no_speech_prob, transcript). Set `TRANSCRIBE_DUMP=1` to also
  keep the last received clip on disk (`$TMPDIR/learn-polish-last-clip.*`) — play it to
  split "bad transcript" into capture-side (silent/garbled audio) vs model-side (clear
  audio, wrong text).
- `POST /analyze` — body `{"text": "..."}`, returns tokens grouped by sentence:

```jsonc
{
  "sentences": [
    { "tokens": [
      { "surface": "Robię", "lemma": "robić", "pos": "VERB",
        "tags": ["Aspect=Imp", "Mood=Ind", "..."], "is_space": false },
      // ...
    ] }
  ]
}
```

- `surface` — the word as it appears in the text (inflected).
- `lemma` — dictionary form; the unit knowledge is tracked against.
- `pos` — UPOS tag (`NOUN`, `VERB`, `ADP`, …).
- `tags` — morphological features (`Case=Acc`, `Number=Sing`, …), possibly empty.
- `is_space` — whitespace/newline token; layout only, skip when counting words.

Sentence boundaries are preserved (needed later for cloze/context). Ambiguity is not
resolved: the analyzer's best single lemma per token is returned (disambiguation parked).

## Tests & benchmark

Both are plain scripts — no pytest, no fixtures.

- **`test_analyze.py`** — correctness of the backlog #2 acceptance case (`Robię obiad w
  kuchni.` → `robić, obiad, w, kuchnia`) and sentence splitting.
  ```sh
  uv run python test_analyze.py      # prints OK, exits non-zero on failure
  ```

- **`test_transcribe.py`** — /transcribe roundtrip: macOS TTS (`say -v Zosia`) speaks
  Polish, whisper transcribes it back (sentence + single-word cases). First run
  downloads the whisper model.
  ```sh
  uv run python test_transcribe.py   # prints OK, exits non-zero on failure
  ```

- **`benchmark.py`** — accuracy of the active analyzer against a hand-checked gold set of
  Polish sentences. Reports lemma + POS accuracy and lists every mismatch, so we can catch
  regressions and compare models/analyzers with one number. Two regression **floors**
  (`LEMMA_FLOOR`, `POS_FLOOR`) make it double as a CI guard: it exits non-zero if accuracy
  drops below them. Extend `GOLD` with more sentences to widen coverage; raise the floors
  when the analyzer improves.
  ```sh
  uv run python benchmark.py
  ```

### Known analyzer quirks (surfaced by the benchmark)

`pl_core_news_sm` is not perfect; the benchmark documents these rather than hiding them:

- Past-tense verbs may agglutinate the `być` auxiliary into the lemma
  (`Czytałem` → `czytać być`).
- Personal pronouns lemmatize to masculine `on` under spaCy's UD convention
  (`Ona` → `on`).
- Capitalized sentence-initial non-proper words are re-lemmatized on their lowercased
  form in `main.py` (the sm lookup is case-sensitive); proper nouns keep their case.
