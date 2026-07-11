# Learn Polish

Single-user, local-first web app for learning Polish. Content-driven: vocabulary is
mined from real Polish text the user reads, then practiced through many exercise types.

## Language

**Surface form**:
A word exactly as it appears in a text, including its inflection. *kota*, *kotu*, and
*kotem* are three surface forms.
_Avoid_: token, word (when precision matters)

**Lemma**:
The dictionary/base form of a word that groups all its surface forms. *kot* is the lemma
of *kota*, *kotu*, *kotem*. The unit at which knowledge is tracked.
_Avoid_: root, stem, base word

**Multi-word expression (MWE)**:
A fixed expression whose meaning is not derivable from its parts — *na pewno* (di sicuro),
*dzień dobry*, *zdawać sobie sprawę* (rendersi conto). A lexical unit in its own right and
therefore a **Tracked unit**. May be discontinuous in a sentence (*zdaję sobie z tego
sprawę*). Compositional phrases (*ciekawe rzeczy*, *czerwone wino*) are NOT MWEs — they
stay separate lemmas.
_Avoid_: phrase, collocation, idiom (as data terms)

**Tracked unit**:
What the user's knowledge is recorded against: a **Lemma** (plus the set of **Surface
forms** encountered) or a **Multi-word expression**. Never a raw surface form.

**L1**:
The learner's native language. Here it is **Italian**, not English. All translations,
glosses, and UI copy are Italian. (L2 = the language being learned = Polish.)

**Gloss**:
The Italian meaning attached to a Polish **Tracked unit** or word-sense, shown while
reading and used in exercises. Sourced per word-sense, not per surface form. Machine-
generated glosses are provisional; a **Manual gloss** overrides them.

**Manual gloss**:
A **Gloss** written or corrected by the learner. The highest-trust tier: never overwritten
or purged by automated regeneration.

**Knowledge state**:
Per-lemma memory tracked with the FSRS algorithm (stability/difficulty → due date), rather
than a fixed status ladder. Split into two independent tracks: **Receptive** and
**Productive**.

**Receptive knowledge**:
Ability to *understand* a lemma when reading or hearing it. Fed by reading, listening,
PL→IT translation, recognition-style grammar exercises, and **Read-aloud** (the word is on
screen — decoding and pronouncing it is comprehension evidence, not retrieval).

**Productive knowledge**:
Ability to *produce* a lemma from memory when speaking. Fed only by exercises that require
retrieval — producing the lemma without seeing it (**Spoken recall**, spoken grammar
drills). Reading a word off the screen, even aloud, never grades this track. Tracked
separately because comprehension precedes production.

## Practice

**Exercise**:
A pluggable activity that trains one or both knowledge tracks over lemmas from the vocab
store (reader, case drill, listening dictation, speaking, …). All exercises satisfy one
contract; the scheduler treats them uniformly. See ADR-0003.
_Avoid_: game, lesson, quiz

**Practice**:
The default daily session: an SRS-driven **mixed queue** where the scheduler pulls due
lemmas (weakest track first) and renders each through an applicable **Exercise**.
_Avoid_: lesson, review session

**Spoken recall**:
The **Exercise** that proves **Productive knowledge**: given the Italian meaning, say the
Polish lemma; the spoken answer is checked against the target.
_Avoid_: speaking exercise (ambiguous with **Read-aloud**)

**Read-aloud**:
The **Exercise** of reading a displayed Polish sentence out loud. Trains pronunciation and
decoding; grades **Receptive knowledge** only.
_Avoid_: speaking exercise

**Focused drill**:
A secondary mode where the learner explicitly picks one **Exercise** type to grind (e.g.
genitive), instead of the mixed **Practice** queue.

**Home dictionary**:
The Wiktionary-derived data imported into SQLite (POS, senses, IPA, inflection tables),
used as reference and as exercise fuel. Distinct from the **Gloss**, which is the Italian
meaning layered on top. See ADR-0002.
