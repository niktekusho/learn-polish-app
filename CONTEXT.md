# Learn Polish

Single-user, local-first web app for learning Polish. Content-driven: vocabulary is
mined from real Polish text the user reads, then practiced through many exercise types.

## Language

**Surface form**:
A word exactly as it appears in a text, including its inflection. _kota_, _kotu_, and
_kotem_ are three surface forms.
_Avoid_: token, word (when precision matters)

**Lemma**:
The dictionary/base form of a word that groups all its surface forms. _kot_ is the lemma
of _kota_, _kotu_, _kotem_. The unit at which knowledge is tracked.
_Avoid_: root, stem, base word

**Multi-word expression (MWE)**:
A fixed expression whose meaning is not derivable from its parts — _na pewno_ (di sicuro),
_dzień dobry_, _zdawać sobie sprawę_ (rendersi conto). A lexical unit in its own right and
therefore a **Tracked unit**. May be discontinuous in a sentence (_zdaję sobie z tego
sprawę_). Compositional phrases (_ciekawe rzeczy_, _czerwone wino_) are NOT MWEs — they
stay separate lemmas. Detected at text import by matching token runs against the **Home
dictionary**'s multi-word headwords (contiguous only in v1; discontinuous parked).
_Avoid_: phrase, collocation, idiom (as data terms)

**Tracked unit**:
What the user's knowledge is recorded against: a **Lemma** (plus the set of **Surface
forms** encountered) or a **Multi-word expression**. Never a raw surface form.

**L1**:
The learner's native language. Here it is **Italian**, not English. All translations,
glosses, and UI copy are Italian. (L2 = the language being learned = Polish.)

**Gloss**:
The Italian meaning attached to a Polish **Tracked unit** or word-sense, shown while
reading and used in exercises. Sourced per word-sense, not per surface form: for lemmas
in the **Home dictionary**, one LLM call translates every Wiktionary sense and flags the
one fitting the sentence (the inline gloss); out-of-dictionary lemmas fall back to
sentence-context generation. Machine-generated glosses are provisional; a **Manual
gloss** overrides them.

**Manual gloss**:
A **Gloss** written or corrected by the learner. The highest-trust tier: never overwritten
or purged by automated regeneration.

**Knowledge state**:
Per-lemma memory tracked with the FSRS algorithm (stability/difficulty → due date), rather
than a fixed status ladder. Split into three independent tracks: **Receptive**,
**Productive**, and **Pronunciation**.

**Receptive knowledge**:
Ability to _understand_ a lemma when reading or hearing it. Fed by reading, listening,
PL→IT translation, and recognition-style exercises. Not fed by **Read-aloud**: a failed
attempt to say a word says nothing about understanding it.

**Productive knowledge**:
Ability to _produce_ a lemma from memory when speaking. Fed only by exercises that require
retrieval — producing the lemma without seeing it (**Spoken recall**, spoken grammar
drills). Reading a word off the screen, even aloud, never grades this track. Tracked
separately because comprehension precedes production.

**Pronunciation knowledge**:
Ability to _say_ a lemma intelligibly when it is in front of the learner. Fed only by
speaking attempts made while the word is visible: every **Read-aloud** attempt, and
**Spoken recall** attempts after the answer is revealed. Its FSRS difficulty is "how hard
this word is to say", and its due date decides when the word is proposed again for
speaking. Never fed by retrieval: a struggle to remember is **Productive**, a struggle to
pronounce is **Pronunciation**. A lemma joins this track only after its first
**Receptive** review: understand first, then say, then recall.
_Avoid_: speaking score, pronunciation difficulty (as a separate score — it is the
track's FSRS difficulty)

**Visible attempt**:
A spoken attempt at a lemma made while the lemma is on screen — any **Read-aloud**
attempt, or a **Spoken recall** retry after the answer was revealed. The only evidence
that grades **Pronunciation knowledge**; never evidence of retrieval.

## Practice

**Exercise**:
A pluggable activity that trains one or both knowledge tracks over lemmas from the vocab
store (reader, case drill, listening dictation, speaking, …). All exercises satisfy one
contract; the scheduler treats them uniformly. See ADR-0003.
_Avoid_: game, lesson, quiz

**Practice**:
The default daily session: an SRS-driven **mixed queue** where the scheduler pulls due
lemmas, balanced across the **Knowledge state** tracks (equal shares; a track with too few
dues yields its share to the others; weakest first within each track), and renders each
through an applicable **Exercise**, interleaved rather than grouped by track. Without a
mic, only tracks that need no speaking take part. A lemma graded on a track today is not
drawn for that track again until tomorrow: same-day repetition is the **Retry**'s job.
_Avoid_: lesson, review session

**Retry**:
A missed item (first answer wrong or not produced, never merely hesitant) shown again at
the end of the same **Practice**, after the learner has seen the answer. Once only: a
missed Retry is not retried again. Practice only: it never grades a **Knowledge state**, since the first answer is
the evidence and the retry only proves the learner remembers what they saw seconds ago.
_Avoid_: redo, relearning step (FSRS term for a same-day scheduled review)

**Spoken recall**:
The **Exercise** that proves **Productive knowledge**: given the Italian meaning, say the
Polish lemma; the spoken answer is checked against the target. Only the attempt made
before the answer is revealed (or the learner's self-grade of it) grades **Productive**;
retries after the reveal grade **Pronunciation** only.
_Avoid_: speaking exercise (ambiguous with **Read-aloud**)

**Read-aloud**:
The **Exercise** of reading a displayed Polish sentence out loud. Grades **Pronunciation
knowledge** only, of the target lemma in the sentence.
_Avoid_: speaking exercise

**Comprehension check**:
A question about a text the learner just read, answered to verify understanding of the
text itself. Part of the reading flow, NOT an **Exercise**: it is tied to a text rather
than to lemmas, is not scheduled by SRS, and does not grade any **Knowledge state**.
_Avoid_: quiz, comprehension exercise

**Focused drill**:
A secondary mode where the learner explicitly picks one **Exercise** type to grind (e.g.
genitive), instead of the mixed **Practice** queue.

**Home dictionary**:
The Wiktionary-derived data imported into SQLite (POS, senses, IPA, inflection tables),
used as reference and as exercise fuel. Distinct from the **Gloss**, which is the Italian
meaning layered on top. See ADR-0002.
