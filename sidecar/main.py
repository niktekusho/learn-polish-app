import spacy
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="learn-polish-sidecar")

# Loaded once at import; the model is a project dependency (pl_core_news_sm).
nlp = spacy.load("pl_core_news_sm")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


class AnalyzeRequest(BaseModel):
    text: str


class Token(BaseModel):
    surface: str
    lemma: str
    pos: str  # UPOS (Universal Part of Speech), e.g. NOUN, VERB, ADP
    tags: list[str]  # morphological features, e.g. ["Case=Acc", "Number=Sing"]
    is_space: bool = False  # whitespace/newline token; layout, not a word


class Sentence(BaseModel):
    tokens: list[Token]


class AnalyzeResponse(BaseModel):
    sentences: list[Sentence]


def _lemma(t) -> str:
    # sm model's lemma lookup is case-sensitive: a capitalized sentence-initial
    # word (e.g. "Robię") comes back unlemmatized. Retry on the lowercased form
    # for non-proper titlecase tokens. Guarded by PROPN so names keep their case.
    # ponytail: heuristic, drop it if we move to a bigger/case-robust model.
    if t.pos_ != "PROPN" and t.lemma_ == t.text and t.text[:1].isupper():
        retried = nlp(t.text.lower())[0].lemma_
        if retried:
            return retried
    return t.lemma_


@app.post("/analyze")
def analyze(req: AnalyzeRequest) -> AnalyzeResponse:
    doc = nlp(req.text)
    return AnalyzeResponse(
        sentences=[
            Sentence(
                tokens=[
                    Token(
                        surface=t.text_with_ws,  # keep trailing space; reader reconstructs layout verbatim
                        lemma=_lemma(t),
                        pos=t.pos_,
                        tags=str(t.morph).split("|") if t.morph else [],
                        is_space=t.is_space,
                    )
                    for t in sent
                ]
            )
            for sent in doc.sents
        ]
    )
