from fastapi.testclient import TestClient

from main import app

client = TestClient(app)


def _words(text: str):
    r = client.post("/analyze", json={"text": text})
    assert r.status_code == 200
    return [
        (t["surface"], t["lemma"], t["pos"])
        for s in r.json()["sentences"]
        for t in s["tokens"]
        if not t["is_space"]
    ]


def test_acceptance_sentence():
    # Backlog #2 acceptance: lemmas robić, obiad, w, kuchnia with correct POS.
    words = _words("Robię obiad w kuchni.")
    lemmas = [w[1] for w in words]
    assert lemmas == ["robić", "obiad", "w", "kuchnia", "."], words
    pos = {w[1]: w[2] for w in words}
    assert pos["robić"] == "VERB"
    assert pos["obiad"] == "NOUN"
    assert pos["w"] == "ADP"
    assert pos["kuchnia"] == "NOUN"


def test_sentence_boundaries_preserved():
    r = client.post("/analyze", json={"text": "Idę. Robię obiad."})
    assert len(r.json()["sentences"]) == 2


def test_surface_reconstructs_original():
    # Surfaces carry trailing whitespace so the reader renders spaces between
    # tokens; concatenating them must reproduce the input verbatim.
    text = "Ola szykuje się do szkoły. Jest już w piątej klasie."
    r = client.post("/analyze", json={"text": text})
    surfaces = [t["surface"] for s in r.json()["sentences"] for t in s["tokens"]]
    assert "".join(surfaces) == text


if __name__ == "__main__":
    test_acceptance_sentence()
    test_sentence_boundaries_preserved()
    test_surface_reconstructs_original()
    print("OK")
