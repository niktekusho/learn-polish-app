# TypeScript app with a Python morphology sidecar

The app is built on TanStack Start (React), which also serves as the TypeScript
backend (server routes + SQLite). Polish morphological analysis (lemma + inflection
tags) has no credible JavaScript implementation, so it runs in a small Python sidecar
service (FastAPI, exposing spaCy `pl_core_news` / Morfeusz2) that the TS server calls
over localhost HTTP.

We deliberately reject in-process JS↔Python bridges (`pythonia`, `python-bridge`) as
fragile, and reject a pure-TS stack because it would sacrifice morphology quality — the
one capability that makes lemma-based tracking, and therefore the whole app, possible.
The Python footprint is kept minimal: only morphology lives there. Whisper ASR runs in
the JS runtime (`whisper.cpp` bindings / `transformers.js`), and everything else — vocab
store, SRS, glossing, LLM calls — is TypeScript.

## Consequences

- Running the app locally means starting two processes (TS app + Python sidecar).
- The morphology boundary is an HTTP contract, so the analyzer can be swapped or scaled
  independently, and can be mocked in tests without Python present.
