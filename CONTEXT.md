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
of _kota_, _kotu_, _kotem_. The unit at which knowledge is tracked, except for a
**Name**, whose lemma only groups its forms. Assigned at text import by the morphology
analyzer, corrected by the **Home dictionary**'s inflected forms when the analyzer's lemma
is not a headword for the word's part of speech.
_Avoid_: root, stem, base word

**Multi-word expression (MWE)**:
A fixed expression whose meaning is not derivable from its parts — _na pewno_ (di sicuro),
_dzień dobry_, _zdawać sobie sprawę_ (rendersi conto). A lexical unit in its own right and
therefore a **Tracked unit**. May be discontinuous in a sentence (_zdaję sobie z tego
sprawę_). Compositional phrases (_ciekawe rzeczy_, _czerwone wino_) are NOT MWEs — they
stay separate lemmas. Detected at text import by matching token runs against the **Home
dictionary**'s multi-word headwords (contiguous only in v1; discontinuous parked).
A match is only a candidate: the same words can form a compositional phrase (_To jest
chleb_ is "questo è pane", not the _to jest_ meaning "cioè"), so each match is checked
in its sentence before it counts.
_Avoid_: phrase, collocation, idiom (as data terms)

**Suppressed MWE**:
A **Multi-word expression** the learner has marked as never-detect, for when the
in-context check keeps letting false matches through. Its occurrences and **Knowledge
state** are removed. Restoring it rechecks past texts and starts its knowledge fresh.

**Tracked unit**:
What the user's knowledge is recorded against: a **Lemma** (plus the set of **Surface
forms** encountered) or a **Multi-word expression**. Never a raw surface form, never a **Name**.

**Formula**:
An inflected word used as a fixed interjection: _proszę_ ("prego", "ecco a lei"),
_dziękuję_, _przepraszam_. A **Tracked unit** in its own right, separate from the verb it
is a form of: _Proszę o chleb_ is still _prosić_. A candidate when the surface form is an
interjection headword in the **Home dictionary** and the analyzer gave it a different
lemma; each occurrence is checked in its sentence like a **Multi-word expression** match.
No word list: the dictionary decides the candidates.
_Avoid_: politeness word, set phrase

**Name**:
A proper noun in a text: a person (_Kasia_) or a place (_Warszawa_). Never a **Tracked
unit**: it has no Italian meaning to learn. Only its inflection is of interest, so the
reader shows the base form and case of an inflected name (_Kasi_ → _Kasia_, genitive).
A word tagged proper noun only because it is capitalized (_Bułka_ at sentence start) is
not a Name when the **Home dictionary** has it as a common word and not as a name.
_Avoid_: proper noun (as a data term), PROPN

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
attempt to say a word says nothing about understanding it. Listening here means listening
**Exercises**: hearing a word or sentence played back on request while reading grades
nothing, since the learner asks for it precisely because they don't know the sound.

**Productive knowledge**:
Ability to _produce_ a lemma from memory when speaking. Fed only by retrieval — producing
the lemma without seeing it (**Spoken recall**, spoken grammar drills, free turns in a
**Conversation**). Reading a word off the screen, even aloud, never grades this track. Tracked
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
attempt, a **Spoken recall** retry after the answer was revealed, or a **Model line**
read out in a **Conversation**. The only evidence
that grades **Pronunciation knowledge**; never evidence of retrieval.

**Mature**:
A lemma's state on one **Knowledge state** track once its FSRS stability reaches 21 days.
Per track: a lemma can be Mature on **Receptive** and not on **Productive**. Not final:
a lapse drops it back. Shown in the UI as _consolidata_.
_Avoid_: known, learned, mastered

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

**Context-bound lemma**:
A lemma whose Italian meaning cannot be given without a sentence: _do_ is "a", "fino a",
"in" or "per" depending on the sentence, and "per" alone points just as well to _dla_.
Marked by the learner, one lemma at a time, never by word type: _też_ and _podczas_ are
function words that translate fine alone. Never asked as a single word (recognition,
**Spoken recall**); still practised through **Read-aloud**, where the sentence carries
the meaning.
_Avoid_: function word (as a data term), ambiguous word

**Spoken recall**:
The **Exercise** that proves **Productive knowledge**: given the Italian meaning, say the
Polish lemma; the spoken answer is checked against the target and its **Alternative
answers**. Only the attempt made
before the answer is revealed (or the learner's self-grade of it) grades **Productive**;
retries after the reveal grade **Pronunciation** only.
_Avoid_: speaking exercise (ambiguous with **Read-aloud**)

**Alternative answer**:
A lemma other than the target that also answers a **Spoken recall** prompt, because its
primary **Gloss** is the same Italian: _następny_ for "successivo" when the target is
_kolejny_. Saying one grades that lemma's **Productive knowledge**, then the target is
asked again with the alternative named. Only lemmas the learner has met count; the
reveal lists them beside the target.
_Avoid_: synonym (Polish near-synonyms with other glosses don't count)

**Read-aloud**:
The **Exercise** of reading a displayed Polish sentence out loud. Grades **Pronunciation
knowledge** only, of the target lemma in the sentence.
_Avoid_: speaking exercise

**Passage exercise**:
The **Exercise** of reading 2–3 Polish sentences containing a due lemma and answering an
Italian multiple-choice question whose answer hinges on that lemma in context. Grades
**Receptive knowledge** of that lemma. The receptive exercise for **Context-bound
lemmas**. Differs from a **Comprehension check**: lemma-level, scheduled and graded.
_Avoid_: reading exercise, comprehension exercise

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

**Story**:
An LLM-generated serial fiction at the learner's level, built from known lemmas plus
~10% new ones. Its outline and episode count (at most 10) are set when the learner picks
one of the proposed premises.

**Episode**:
One installment of a **Story**, stored and read as a normal imported text. Episodes and
**Conversations** alternate day by day; one of them plus one **Practice** session make the
daily routine.
_Avoid_: chapter, chunk

**Conversation**:
A spoken role-play with an LLM character from the current **Story**, set right after the
last **Episode** read and played toward a **Goal**. Open: the character follows wherever the learner takes it. Not an **Exercise**:
the learner steers it, though the character is nudged to make due **Productive** lemmas
the natural answer. Counts for the daily once the learner reaches the **Debrief** having
spoken at least 3 turns, whether or not the **Goal** was met.
_Avoid_: dialogue, chat, scene

**Goal**:
The Italian task card a **Conversation** is played toward: _buy two rolls, ask if
there is fresh poppy-seed cake, pay_.
_Avoid_: mission, quest, objective

**Learner profile**:
A few facts about the learner (name, job, city, partner, hobbies), written once in
Italian. In a **Conversation** the learner plays themself from this profile, unless the
**Goal** assigns a role, in which case the card states the role's facts.

**Character memory**:
What a **Story** character knows about the learner from past **Conversations** in that
story: a few lines updated after each **Debrief**. Story-scoped: what carries across
stories belongs in the **Learner profile**.

**Help ladder**:
What a stuck learner climbs during a **Conversation** turn: try freely, then a **Hint**,
then a **Model line**. Each rung grades differently: a free turn is retrieval (**Productive**
Good for the lemmas said), a hinted lemma then said is failed retrieval (**Productive**
Again), a **Model line** read out is a **Visible attempt**.

**Hint**:
The key Polish words for what the learner likely wants to say on a **Conversation** turn.

**Model line**:
A full Polish sentence the learner reads aloud when a **Hint** was not enough.

**Debrief**:
The end of a **Conversation**: up to 10 corrections of the learner's utterances, recurring
patterns first, each with the corrected form and one Italian line. The only place
mistakes are pointed out: in the scene, the character reacts like a patient native,
understanding or asking again, and may repeat what it heard as people do, but never
flags an error.
_Avoid_: review (that is an FSRS review), feedback, report

**Heard line**:
A character line in a **Conversation** the learner followed by ear, without revealing its
text. Counted as listening progress, never graded.

**Echo**:
A lemma the character used in its last line or two, repeated by the learner. Never graded:
parroting is not retrieval.
