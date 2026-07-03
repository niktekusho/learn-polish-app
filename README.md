# learn-polish-app

A personal web app for learning Polish — content-driven like LingQ, but grammar-heavy with
varied exercises like Duolingo, and built for an **Italian** native speaker focused on
**comprehension and speaking**.

You import real Polish text, read it to mine new vocabulary, and practice through a growing
set of exercises. Under the hood, words are tracked by **lemma** (not surface form) using a
morphological analyzer, and memory is scheduled per word with **FSRS**, split into separate
**receptive** and **productive** tracks so "I understand it" and "I can say it" are measured
independently.

## Stack

- **TanStack Start** (React, full-stack) + **SQLite** — the app and its data.
- **Python sidecar** (FastAPI) — Polish morphological analysis, the one thing with no good
  JS equivalent.
- **FSRS** (`ts-fsrs`) for scheduling, **Wiktionary/kaikki** for the home dictionary, an LLM
  for Italian glosses, **Whisper** (JS) for speech.

## Documentation

- [CONTEXT.md](./CONTEXT.md) — the project's shared vocabulary.
- [docs/adr/](./docs/adr/) — architecture decisions and the reasoning behind them.
- [docs/mvp-backlog.md](./docs/mvp-backlog.md) — the first slice, broken into issues.
