import io
import os
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import spacy
from fastapi import FastAPI, UploadFile
from pydantic import BaseModel

app = FastAPI(title="learn-polish-sidecar")

# Loaded once at import; the model is a project dependency (pl_core_news_sm).
nlp = spacy.load("pl_core_news_sm")

# ASR model size/name (faster-whisper), int8 on CPU (CTranslate2 has no MPS).
# `medium` default: on the 2026-07-13 real-clip eval it beat `small` on
# accuracy at the same short-clip latency (~2.5s vs ~3.1s — fixed overhead
# dominates), and large-v3-turbo was *worse* on Polish single words.
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "medium")


@lru_cache(maxsize=1)
def _whisper():
    # Lazy: first /transcribe call pays the model load (and, once ever, the
    # HuggingFace download). Import is deferred too so /analyze-only usage
    # never touches faster-whisper.
    from faster_whisper import WhisperModel

    return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {
        "status": "ok",
        "asr_model": WHISPER_MODEL,
        "asr_loaded": _whisper.cache_info().currsize > 0,
    }


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


class TranscribeResponse(BaseModel):
    text: str  # raw transcript; caller lemmatizes via /analyze if needed


# Debug dump (TRANSCRIBE_DUMP=1): keep the last received clip on disk so a bad
# transcript can be split into capture-side (play the file: silent/garbled?)
# vs model-side (clear audio, wrong text).
_DUMP_ENABLED = os.environ.get("TRANSCRIBE_DUMP") == "1"
_DUMP_STEM = Path(os.getcwd()) / "clips-dump"
_DUMP_EXT = {"audio/ogg": ".ogg", "audio/webm": ".webm", "audio/mp4": ".m4a"}

_DUMP_STEM.mkdir(parents=True, exist_ok=True)

def _dump_clip(data: bytes, content_type: str | None) -> Path | None:
    if not _DUMP_ENABLED:
        return None
    base = (content_type or "").split(";")[0].strip()
    now = datetime.now().strftime("%Y_%m_%d-%H_%M_%S")
    path = (_DUMP_STEM / ('clip-' + now)).with_suffix(_DUMP_EXT.get(base, ".bin"))
    path.write_bytes(data)
    return path


@app.post("/transcribe")
def transcribe(audio: UploadFile) -> TranscribeResponse:
    # Sync `def` on purpose: CPU-bound work runs in FastAPI's threadpool
    # instead of blocking the event loop. PyAV (bundled with faster-whisper)
    # decodes whatever container the browser recorded (ogg/webm/mp4).
    data = audio.file.read()
    dump = _dump_clip(data, audio.content_type)
    segments, info = _whisper().transcribe(
        io.BytesIO(data),
        language="pl",
        vad_filter=True,  # silence in → empty text out, not hallucinations
        condition_on_previous_text=False,  # short clips; no context to condition on
    )
    segs = list(segments)
    text = "".join(s.text for s in segs).strip()
    print(
        f"[transcribe] {len(data)}B {info.duration:.1f}s "
        f"lang_p={info.language_probability:.2f} "
        f"segs={[(round(s.avg_logprob, 2), round(s.no_speech_prob, 2)) for s in segs]} "
        f"→ {text!r}" + (f" (clip: {dump})" if dump else ""),
        flush=True,
    )
    return TranscribeResponse(text=text)
