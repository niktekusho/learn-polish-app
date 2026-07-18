"""Roundtrip test for /transcribe: macOS TTS (Zosia) speaks Polish, whisper
transcribes it back. First run downloads the whisper model (~460MB) — the same
download the app needs anyway. Plain script, repo convention (no pytest).

    uv run python test_transcribe.py      # prints OK, exits non-zero on failure
"""

import subprocess
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def _speak(text: str) -> Path:
    out = Path(tempfile.mkdtemp()) / "clip.wav"
    subprocess.run(
        ["say", "-v", "Zosia", "-o", str(out), "--data-format=LEI16@16000", text],
        check=True,
    )
    return out


def _transcribe(path: Path) -> str:
    with open(path, "rb") as f:
        r = client.post("/transcribe", files={"audio": ("clip.wav", f, "audio/wav")})
    assert r.status_code == 200, r.text
    return r.json()["text"]


def test_health_reports_asr():
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert "asr_model" in body and "asr_loaded" in body, body


def test_sentence_roundtrip():
    text = _transcribe(_speak("Robię obiad w kuchni."))
    assert "obiad" in text.lower(), text
    assert "kuchni" in text.lower(), text


def test_single_word_roundtrip():
    # Single short words are whisper's weakest case (roadmap Slice 1); the
    # fallback UX covers real misfires, but clean TTS input must pass.
    text = _transcribe(_speak("kobieta"))
    assert "kobieta" in text.lower(), text


if __name__ == "__main__":
    test_health_reports_asr()
    test_sentence_roundtrip()
    test_single_word_roundtrip()
    print("OK")
