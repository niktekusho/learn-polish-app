"""Accuracy benchmark for the /analyze morphology endpoint.

Distinct from test_analyze.py (correctness of one acceptance case): this scores the
active analyzer against a small gold set of Polish sentences, so we can spot lemma/POS
regressions and compare analyzers/models (sm vs md vs Morfeusz2) with one number.

Gold is hand-checked (lemma + UPOS per non-space token). Run: `uv run python benchmark.py`.
Extend GOLD with more sentences as coverage grows. Floors below double as a CI guard.
"""

from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

# Each entry: (sentence, [(surface, lemma, UPOS), ...]) for non-space tokens, in order.
GOLD: list[tuple[str, list[tuple[str, str, str]]]] = [
    ("Robię obiad w kuchni.", [
        ("Robię", "robić", "VERB"), ("obiad", "obiad", "NOUN"),
        ("w", "w", "ADP"), ("kuchni", "kuchnia", "NOUN"), (".", ".", "PUNCT"),
    ]),
    ("Kot pije mleko.", [
        ("Kot", "kot", "NOUN"), ("pije", "pić", "VERB"),
        ("mleko", "mleko", "NOUN"), (".", ".", "PUNCT"),
    ]),
    ("Czytałem ciekawą książkę wczoraj.", [
        ("Czytałem", "czytać", "VERB"), ("ciekawą", "ciekawy", "ADJ"),
        ("książkę", "książka", "NOUN"), ("wczoraj", "wczoraj", "ADV"),
        (".", ".", "PUNCT"),
    ]),
    ("Ania mieszka w Warszawie.", [
        ("Ania", "Ania", "PROPN"), ("mieszka", "mieszkać", "VERB"),
        ("w", "w", "ADP"), ("Warszawie", "Warszawa", "PROPN"), (".", ".", "PUNCT"),
    ]),
    ("Ona ma dwa duże psy.", [
        ("Ona", "ona", "PRON"), ("ma", "mieć", "VERB"), ("dwa", "dwa", "NUM"),
        ("duże", "duży", "ADJ"), ("psy", "pies", "NOUN"), (".", ".", "PUNCT"),
    ]),
    ("Nie lubię zimnej wody.", [
        ("Nie", "nie", "PART"), ("lubię", "lubić", "VERB"),
        ("zimnej", "zimny", "ADJ"), ("wody", "woda", "NOUN"), (".", ".", "PUNCT"),
    ]),
]

# Regression floors — set just below the current measured accuracy. Raise when the
# analyzer improves; a drop below these fails the run (exit 1).
LEMMA_FLOOR = 0.90
POS_FLOOR = 0.90


def _analyze(text: str) -> list[tuple[str, str, str]]:
    r = client.post("/analyze", json={"text": text})
    assert r.status_code == 200, r.text
    return [
        (t["surface"], t["lemma"], t["pos"])
        for s in r.json()["sentences"]
        for t in s["tokens"]
        if not t["is_space"]
    ]


def main() -> int:
    lemma_ok = pos_ok = total = 0
    mismatches: list[str] = []

    for text, gold in GOLD:
        got = _analyze(text)
        if len(got) != len(gold):
            mismatches.append(
                f"  TOKENIZATION {text!r}: expected {len(gold)} tokens, got {len(got)}\n"
                f"    gold: {[g[0] for g in gold]}\n    got:  {[g[0] for g in got]}"
            )
            total += len(gold)
            continue
        for (_, g_lemma, g_pos), (surface, lemma, pos) in zip(gold, got):
            total += 1
            if lemma == g_lemma:
                lemma_ok += 1
            else:
                mismatches.append(f"  LEMMA {surface!r}: expected {g_lemma!r}, got {lemma!r}")
            if pos == g_pos:
                pos_ok += 1
            else:
                mismatches.append(f"  POS   {surface!r}: expected {g_pos!r}, got {pos!r}")

    lemma_acc = lemma_ok / total
    pos_acc = pos_ok / total
    print(f"Analyzer benchmark — {len(GOLD)} sentences, {total} tokens")
    print(f"  lemma accuracy: {lemma_acc:.1%} ({lemma_ok}/{total})")
    print(f"  POS   accuracy: {pos_acc:.1%} ({pos_ok}/{total})")
    if mismatches:
        print("mismatches:")
        print("\n".join(mismatches))

    if lemma_acc < LEMMA_FLOOR or pos_acc < POS_FLOOR:
        print(f"FAIL: below floor (lemma {LEMMA_FLOOR:.0%}, pos {POS_FLOOR:.0%})")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
