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

**Tracked unit**:
What the user's knowledge is recorded against. It is the **Lemma** plus the set of
**Surface forms** encountered, not the raw surface form.

**L1**:
The learner's native language. Here it is **Italian**, not English. All translations,
glosses, and UI copy are Italian. (L2 = the language being learned = Polish.)

**Gloss**:
The Italian meaning attached to a Polish lemma or word-sense, shown while reading and used
in exercises. Sourced per word-sense, not per surface form.

**Knowledge state**:
Per-lemma memory tracked with the FSRS algorithm (stability/difficulty → due date), rather
than a fixed status ladder. Split into two independent tracks: **Receptive** and
**Productive**.

**Receptive knowledge**:
Ability to *understand* a lemma when reading or hearing it. Fed by reading, listening,
PL→IT translation, and recognition-style grammar exercises.

**Productive knowledge**:
Ability to *produce* a lemma when speaking. Fed by speaking exercises (tier-2 ASR) and
spoken grammar drills. Tracked separately because comprehension precedes production.

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

**Focused drill**:
A secondary mode where the learner explicitly picks one **Exercise** type to grind (e.g.
genitive), instead of the mixed **Practice** queue.

**Home dictionary**:
The Wiktionary-derived data imported into SQLite (POS, senses, IPA, inflection tables),
used as reference and as exercise fuel. Distinct from the **Gloss**, which is the Italian
meaning layered on top. See ADR-0002.
