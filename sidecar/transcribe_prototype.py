"""PROTOTYPE, throwaway: /transcribe-prototype for the /stt-prototype page (#41).

Same model as /transcribe, with the candidate changes from
docs/research/browser-audio-capture-for-stt.md behind query params. With every
param at its default it decodes exactly like /transcribe.
"""

import hashlib
import io
import re

import numpy as np
from fastapi import APIRouter, UploadFile

router = APIRouter()

PEAK_TARGET = 10 ** (-3 / 20)  # -3 dBFS


def _db(x: float) -> float:
    return round(float(20 * np.log10(x + 1e-9)), 1)


@router.post("/transcribe-prototype")
def transcribe_prototype(
    audio: UploadFile,
    normalize: bool = False,
    vad: bool = True,
    temperature0: bool = False,
    hotwords: str = "",
    label: str = "",
) -> dict:
    import main  # deferred: main imports this module
    from faster_whisper.audio import decode_audio

    data = audio.file.read()
    if main._DUMP_ENABLED:
        # One file per recording: the page posts the same clip once per variant.
        ext = main._DUMP_EXT.get((audio.content_type or "").split(";")[0].strip(), ".bin")
        name = f"{re.sub(r'[^a-z0-9-]', '', label)}-{hashlib.sha1(data).hexdigest()[:10]}{ext}"
        folder = main._DUMP_STEM / "prototype"
        folder.mkdir(exist_ok=True)
        (folder / name).write_bytes(data)

    wave = decode_audio(io.BytesIO(data))  # 16 kHz mono float32, what the model sees
    frames = wave[: len(wave) // 320 * 320].reshape(-1, 320)  # 20 ms
    frame_rms = np.sqrt((frames**2).mean(axis=1)) if len(frames) else np.zeros(1)
    stats = {
        "seconds": round(len(wave) / 16000, 2),
        "peak_db": _db(float(np.abs(wave).max())) if len(wave) else None,
        "speech_db": _db(float(np.percentile(frame_rms, 95))),
        "noise_db": _db(float(np.percentile(frame_rms, 10))),
        "zero_frames_pct": round(float((frame_rms < 1e-4).mean()) * 100),
    }

    if normalize and len(wave):
        wave = wave * (PEAK_TARGET / (np.abs(wave).max() + 1e-9))

    options: dict = {}
    if temperature0:
        options["temperature"] = 0.0
    if hotwords.strip():
        options["hotwords"] = hotwords.strip()
    segments, _ = main._whisper().transcribe(
        wave,
        language="pl",
        vad_filter=vad,
        condition_on_previous_text=False,
        **options,
    )
    segs = list(segments)
    return {
        "text": "".join(s.text for s in segs).strip(),
        "avg_logprob": round(float(np.mean([s.avg_logprob for s in segs])), 2) if segs else None,
        "no_speech_prob": round(float(np.max([s.no_speech_prob for s in segs])), 2) if segs else None,
        "temperatures": [s.temperature for s in segs],
        "stats": stats,
    }
