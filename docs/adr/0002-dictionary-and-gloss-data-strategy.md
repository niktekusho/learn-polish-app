# Dictionary and Italian-gloss data strategy

## Context

The app needs (a) a reference dictionary with parts of speech, declension/conjugation
tables, IPA pronunciation, and word senses, and (b) Italian **glosses** that render in the
reader and feed exercises. Polish→Italian bilingual data is thin, and PL→IT dictionary
dumps don't exist at usable coverage.

## Decision

**Home dictionary = Wiktionary via Wiktextract (kaikki.org).** Import the pre-parsed
Polish JSONL extraction (from the English Wiktionary) into SQLite once: lemma, POS, senses,
IPA, inflection tables. This is machine-readable, offline, free, and does triple duty —
reference panel, grammar-exercise fuel (declension tables), and pronunciation data (IPA).
We do **not** parse Wiktionary wikitext ourselves; Wiktextract already did.

**Italian glosses = LLM over the Wiktionary English sense, cached in SQLite**, generated in
two waves rather than bulk-translating the whole dump:
- Onboarding: batch-translate the top ~5k frequency lemmas so common words are instant.
- Lazy: translate any long-tail lemma on first encounter in reading, then persist.
Cost tracks the learner's actual vocabulary, not Wiktionary's ~100k+ size. English senses
are an acceptable fallback (the learner already reads English Wiktionary).

**External links for human deep-dives:** Wiktionary (`.../wiki/{lemma}#Polish`) and Diki.
Diki is link-only — it has no dump or API, and scraping it is against its ToS.

## Consequences

- Wiktionary data is CC-BY-SA: attribution + share-alike. Irrelevant for personal use;
  matters only if the app is ever distributed.
- The kaikki dictionary complements the morphology sidecar (ADR-0001): the analyzer parses
  running text (form → lemma); Wiktionary supplies the inflection tables for drills.

## Amendment (2026-07-11): interim gloss source until kaikki lands

The kaikki Home-dictionary import is still parked, so there are **no Wiktionary senses
to translate from**. The shipped lazy wave therefore diverges from the decision above:
it generates the Italian gloss from the **Polish lemma + its sentence context** (via a
click-time LLM provider), and stores **one gloss per lemma** (`gloss.sense = ''`).

This is a deliberate interim, not a change of target:
- Sourcing glosses from the **Wiktionary English sense** and storing **one gloss per
  word-sense** (the decision above, and CONTEXT.md's "Gloss … sourced per word-sense")
  remain the goal, **gated on the kaikki import**.
- Consequence of the interim: a polysemous lemma shows only its first-encountered sense
  (e.g. *zamek* = castle/lock/zipper). Acceptable for single-user MVP reading.
  - Confirmed in dogfooding (2026-07-12): *przedmiot* cached as "oggetto", wrong in a
    school text ("materia scolastica"). Decision: stay blocked on kaikki rather than
    build LLM-derived senses; live with first-sense-wins meanwhile.
- When kaikki lands, the onboarding wave batch-translates senses; sentence-context
  generation is retained only as the **lazy fallback** for lemmas absent from the dump.
