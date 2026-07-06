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

## Running locally

Prereqs: Node 24+, [pnpm](https://pnpm.io), [uv](https://docs.astral.sh/uv/). The sidecar
pins Python 3.13 via `sidecar/.python-version` (spaCy has no 3.14 wheels yet); `uv` fetches
it automatically, so no system Python needed.

```sh
pnpm install            # JS deps (TanStack app, Drizzle, better-sqlite3)
uv sync --project sidecar   # Python deps (FastAPI, uvicorn, spaCy + pl_core_news_sm)
pnpm dev                # starts app + sidecar together (concurrently)
```

- App: <http://localhost:3000> (TanStack Start, port 3000)
- Sidecar: <http://localhost:8000> — `GET /health` → `{"status":"ok"}`;
  `POST /analyze {"text": "..."}` → tokens `{surface, lemma, pos, tags}` grouped by sentence

Run them separately if you prefer: `pnpm dev:app` and `pnpm dev:sidecar`.

### Database

SQLite lives at `app/data/app.db` (gitignored, WAL). Schema is defined with Drizzle
in [`app/src/db/schema.ts`](app/src/db/schema.ts); migrations are applied automatically on
app startup.

```sh
pnpm db:generate   # generate a migration after editing the schema
pnpm db:migrate    # apply migrations manually (also runs on app boot)
```

### Layout

```
app/       TanStack Start (React) + SQLite (Drizzle / better-sqlite3)
sidecar/   Python FastAPI morphology service (uv-managed)
```

## Documentation

- [CONTEXT.md](./CONTEXT.md) — the project's shared vocabulary.
- [docs/adr/](./docs/adr/) — architecture decisions and the reasoning behind them.
- [docs/mvp-backlog.md](./docs/mvp-backlog.md) — the first slice, broken into issues.
