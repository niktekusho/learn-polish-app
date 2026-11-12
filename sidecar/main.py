import hashlib
import io
import os
import wave
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path

import spacy
from fastapi import Depends, FastAPI, HTTPException, Response, UploadFile
from pydantic import BaseModel

app = FastAPI(title="learn-polish-sidecar")

# PROTOTYPE (#41), throwaway: delete with transcribe_prototype.py.
from transcribe_prototype import router as _transcribe_prototype  # noqa: E402

app.include_router(_transcribe_prototype)

# Loaded once at import; the model is a project dependency (pl_core_news_sm).
nlp = spacy.load("pl_core_news_sm")

# ASR model size/name (faster-whisper), int8 on CPU (CTranslate2 has no MPS).
# `medium` default: on the 2026-07-13 real-clip eval it beat `small` on
# accuracy at the same short-clip latency (~2.5s vs ~3.1s: fixed overhead
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
_DUMP_STEM = Path(os.environ.get("TRANSCRIBE_DUMP_DIR") or Path(os.getcwd()) / "clips-dump")
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


@dataclass(frozen=True)
class Voice:
    model: str  # Piper voice name in rhasspy/piper-voices
    label: str  # Italian, shown to the learner


VOICES = {
    "bass": Voice("pl_PL-bass-high", "Voce maschile molto grave"),
    "darkman": Voice("pl_PL-darkman-medium", "Voce maschile media"),
    "gosia": Voice("pl_PL-gosia-medium", "Voce femminile"),
    "mc_speech": Voice("pl_PL-mc_speech-medium", "Voce maschile grave"),
    "mls_6892": Voice("pl_PL-mls_6892-low", "Voce maschile, audio meno nitido"),
}

_CACHE_ROOT = Path.home() / ".cache" / "learn-polish"
PIPER_VOICES_DIR = Path(os.environ.get("PIPER_VOICES_DIR", _CACHE_ROOT / "piper-voices"))
SPEAK_CACHE_DIR = Path(os.environ.get("SPEAK_CACHE_DIR", _CACHE_ROOT / "speak-cache"))

Synthesize = Callable[[str, str], bytes]  # (Piper model, text) -> WAV bytes


@lru_cache(maxsize=None)
def _piper_voice(model: str):
    from piper import PiperVoice
    from piper.download_voices import download_voice

    PIPER_VOICES_DIR.mkdir(parents=True, exist_ok=True)
    download_voice(model, PIPER_VOICES_DIR)  # skips files already on disk
    return PiperVoice.load(PIPER_VOICES_DIR / f"{model}.onnx")


def piper_synthesize(model: str, text: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        _piper_voice(model).synthesize_wav(text, w)
    return buf.getvalue()


def get_synthesizer() -> Synthesize:
    return piper_synthesize


def get_speak_cache_dir() -> Path:
    return SPEAK_CACHE_DIR


class VoiceInfo(BaseModel):
    id: str
    label: str


@app.get("/voices")
def voices() -> list[VoiceInfo]:
    return [VoiceInfo(id=id, label=v.label) for id, v in VOICES.items()]


class SpeakRequest(BaseModel):
    text: str
    voice: str


@app.post("/speak")
def speak(
    req: SpeakRequest,
    synthesize: Synthesize = Depends(get_synthesizer),
    cache_dir: Path = Depends(get_speak_cache_dir),
) -> Response:
    voice = VOICES.get(req.voice)
    if voice is None:
        known = ", ".join(VOICES)
        raise HTTPException(400, f"Unknown voice '{req.voice}'. Known voices: {known}.")
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "Text is empty.")

    # Keyed by the Piper model, so changing a catalog entry's model never serves old audio.
    path = cache_dir / voice.model / f"{hashlib.sha256(text.encode()).hexdigest()}.wav"
    if path.exists():
        return Response(path.read_bytes(), media_type="audio/wav")
    audio = synthesize(voice.model, text)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(audio)
    tmp.replace(path)  # a crash mid-write never leaves a truncated cache entry
    return Response(audio, media_type="audio/wav")
