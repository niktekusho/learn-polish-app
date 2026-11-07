import io
import wave

import pytest
from fastapi.testclient import TestClient

from main import VOICES, app, get_speak_cache_dir, get_synthesizer

client = TestClient(app)

CATALOG = ["bass", "darkman", "gosia", "mc_speech", "mls_6892"]


def _wav(seed: str) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(22050)
        w.writeframes(seed.encode() * 10)
    return buf.getvalue()


class FakeSynth:
    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def __call__(self, model: str, text: str) -> bytes:
        self.calls.append((model, text))
        return _wav(f"{model}:{text}")


@pytest.fixture
def synth(tmp_path):
    fake = FakeSynth()
    app.dependency_overrides[get_synthesizer] = lambda: fake
    app.dependency_overrides[get_speak_cache_dir] = lambda: tmp_path
    yield fake
    app.dependency_overrides.clear()


def _speak(text: str, voice: str):
    return client.post("/speak", json={"text": text, "voice": voice})


def test_voices_lists_the_catalog_with_labels():
    r = client.get("/voices")
    assert r.status_code == 200
    body = r.json()
    assert [v["id"] for v in body] == CATALOG
    assert all(v["label"] for v in body)


@pytest.mark.parametrize("voice", CATALOG)
def test_speak_returns_wav_in_each_voice(synth, voice):
    r = _speak("Dzień dobry, poproszę dwie bułki.", voice)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "audio/wav"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getnframes() > 0
    assert synth.calls == [(VOICES[voice].model, "Dzień dobry, poproszę dwie bułki.")]


def test_repeat_request_is_served_from_cache(synth):
    first = _speak("Dzień dobry.", "gosia")
    second = _speak("Dzień dobry.", "gosia")
    assert second.status_code == 200
    assert second.content == first.content
    assert len(synth.calls) == 1


def test_cache_is_per_voice_and_text(synth):
    _speak("Dzień dobry.", "gosia")
    _speak("Dzień dobry.", "bass")
    _speak("Do widzenia.", "gosia")
    assert len(synth.calls) == 3


def test_surrounding_whitespace_shares_the_cache_entry(synth):
    _speak("Dzień dobry.", "gosia")
    _speak("  Dzień dobry.\n", "gosia")
    assert len(synth.calls) == 1


def test_unknown_voice_is_rejected(synth):
    r = _speak("Dzień dobry.", "zosia")
    assert r.status_code == 400
    assert "zosia" in r.json()["detail"]
    assert synth.calls == []


def test_blank_text_is_rejected(synth):
    r = _speak("   ", "gosia")
    assert r.status_code == 400
    assert synth.calls == []
