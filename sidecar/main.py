from fastapi import FastAPI

app = FastAPI(title="learn-polish-sidecar")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# Backlog #2: POST /analyze -> tokens with {surface, lemma, pos, tags} via spaCy pl_core_news.
