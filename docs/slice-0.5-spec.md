# Slice 0.5 Spec — Fresh content + visible progress

Status: ready for agent. Design session 2026-10-14; decisions recorded in
[roadmap.md](./roadmap.md) "Slice 0.5". Terms per [CONTEXT.md](../CONTEXT.md).

Ship order, each shippable on its own: **1) Recap + streak → 2) Story + Episodes →
3) Passage exercise.**

## Problem Statement

After 9 straight days of the restarted daily habit (~20 reviews/day, no missed day),
Practice feels samey. Only 2 texts were ever imported (2026-07-11), so every **Tracked
unit** in the store comes from them and the same 187 lemmas cycle through the same 3
exercises. Importing more is not blocked by the paste flow: finding Polish text that is
both readable at sub-A1 and interesting takes effort, and the paper books stay unread for
the same reason. Separately, the app never says what a day achieved: there is no "well
done, you learned X, improved Y", and that is the delight the learner misses. The phone
alarm works as the trigger; an in-app reward was never felt.

## Solution

- The daily routine becomes **one Practice session + one Episode**. Finishing either keeps
  the streak; finishing both is a *giornata completa*.
- After each one, a one-line note says what changed. When both are done, a daily recap
  shows new words, words that got stronger (with 3 examples), words that became **Mature**
  (*consolidate*), and the streak.
- A **Story**: the app proposes 3 premises, the learner taps one, and an LLM writes a
  serial at the learner's level (known lemmas + ~10% new), one **Episode** per day, at
  most 10 episodes. The next episode is always ready: it is generated in the background
  when the current one is finished. Episodes are read in the existing reader, so new
  vocabulary is mined the usual way.
- A **Passage exercise** joins Practice: 2–3 sentences around a due lemma, then an
  Italian question whose answer depends on that lemma. It grades **Receptive**, mixes
  50/50 with recognition MCQ, and becomes the receptive exercise for **Context-bound
  lemmas**.

## User Stories

### Recap + streak

1. As the learner, I want finishing a Practice session to count as half of my daily, so that the app mirrors the routine I actually do.
2. As the learner, I want marking an Episode as read to count as the other half, so that reading is part of the routine.
3. As the learner, I want a streak counter that grows on any day I finish at least one of the two, so that a short day still keeps the chain alive ("never miss twice").
4. As the learner, I want the streak to reset after a day with nothing done, so that the number stays honest.
5. As the learner, I want today's in-progress day not to break the streak before I've had the chance to practise, so that opening the app in the morning doesn't show a reset.
6. As the learner, I want a one-line note at the end of a Practice session ("+3 parole più solide"), so that each session ends with visible progress.
7. As the learner, I want a one-line note after marking an Episode as read (e.g. new words met), so that reading also ends with visible progress.
8. As the learner, I want a daily recap screen when both items are done, so that the day feels finished and earned.
9. As the learner, I want the recap to count the new words I reviewed for the first time today, so that I see vocabulary growing.
10. As the learner, I want the recap to count the words whose memory got stronger today, so that I see reviews paying off.
11. As the learner, I want 3 example words among those that got stronger, so that the number feels concrete.
12. As the learner, I want the recap to count words that became Mature today, shown as *consolidate*, so that I get a "you learned this" moment.
13. As the learner, I want Mature to be counted per lemma (a word maturing on two tracks counts once), so that the number means words, not cards.
14. As the learner, I want the recap to show the streak, so that I see the chain I'm protecting.
15. As the learner, I want a *giornata completa* marker when both items are done, so that a full day is distinguished from a minimum day.
16. As the learner, I want the home screen to show which of today's two items are done, so that I know what is left at a glance.
17. As the learner, I want all recap copy in Italian, so that it matches the rest of the UI.
18. As the learner, I want the recap to be reachable again later the same day, so that closing it by mistake loses nothing.
19. As the learner, I want "today" to follow my local day, matching Practice's same-day rule, so that late-evening sessions land on the right day.

### Story + Episodes

20. As the learner, I want the app to propose 3 story premises (genre + one-line hook, in Italian), so that I don't have to find interesting texts myself.
21. As the learner, I want a reroll that proposes 3 different premises, so that I can skip premises that don't grab me.
22. As the learner, I want one tap on a premise to start the story, so that starting costs no effort.
23. As the learner, I want the story's length decided by its plot (at most 10 episodes), so that good stories aren't forced into a fixed shape.
24. As the learner, I want the plot planned up front (outline, characters, episode count), so that the episodes stay coherent and build to an ending.
25. As the learner, I want each episode written mostly with words I already know, with about 10% new ones, so that I can read it without drowning.
26. As the learner, I want an episode that misses the level by a lot to be regenerated before I see it, so that a bad LLM draw never reaches me.
27. As the learner, I want the next episode ready when I open Read, so that I never wait on an LLM at morning coffee.
28. As the learner, I want an episode to open in the normal reader, so that glosses, the word panel, listen and the comprehension check all work as usual.
29. As the learner, I want words I click in an episode to enter my vocab store like any imported text, so that the story feeds Practice with fresh words.
30. As the learner, I want a way to mark an episode as read, so that it counts toward my daily and triggers the next one.
31. As the learner, I want finishing the comprehension check to also mark the episode read, so that I don't have to press two buttons.
32. As the learner, I want to see the story title and "episodio N" on the episode, so that I know where I am in the story.
33. As the learner, I want earlier episodes of the current story listed, so that I can reread them.
34. As the learner, I want a clear end screen when the final episode is read, followed by new premises, so that finishing a story feels like an achievement.
35. As the learner, I want a "new story" action that abandons the current story, so that a dull story doesn't block my reading.
36. As the learner, I want an abandoned story's episodes to stay readable as texts, so that the vocabulary I mined keeps its sentences.
37. As the learner, I want a failed background generation to be retried when I open Read, with a visible wait only in that case, so that a hiccup doesn't lose my episode.
38. As the learner, I want only one active story at a time, so that the daily item is always unambiguous.

### Passage exercise

39. As the learner, I want some receptive reviews to show a short passage of 2–3 Polish sentences, so that I practise reading words in context, not only in isolation.
40. As the learner, I want an Italian multiple-choice question whose answer depends on the target word, so that answering proves I understood that word.
41. As the learner, I want passages taken from texts and episodes I've already read, so that the sentences carry memories from my own reading.
42. As the learner, I want a generated passage when none of my texts has a usable sentence, so that every lemma can get a passage.
43. As the learner, I want MCQ and Passage mixed at random for receptive reviews, so that Practice stops feeling samey.
44. As the learner, I want context-bound lemmas (*do*, *za*…) to be asked through passages, so that their meaning is trained the only way it can be: in a sentence.
45. As the learner, I want a correct answer to grade the lemma's Receptive track the same way an MCQ does, so that scheduling stays consistent.
46. As the learner, I want a wrong answer to show the correct choice and enter the Retry like any missed item, so that Passage follows the Practice rules I know.
47. As the learner, I want to report a bad passage question, so that a wrong answer key doesn't keep punishing me.
48. As the learner, I want Practice to start instantly, with no LLM wait, so that questions are prepared ahead of time.
49. As the learner, I want a lemma with no prepared passage question to fall back to MCQ, so that missing data never blocks a review.
50. As the learner, I want the target word in the passage visible but not glossed, so that the question tests understanding rather than reading a translation.

## Implementation Decisions

### Shared

- **Day boundary**: local calendar day, the same `startOfDay` rule as Practice's same-day exclusion. No timezone setting.
- **Background work**: in-process, fire-and-forget after the triggering request (finishing an episode; finishing a Practice session for passage questions). No job queue. Failures are logged and retried lazily at the next point of need.
- **LLM access** goes through the existing provider abstraction; new prompt builders and JSON parsers sit beside the gloss and comprehension ones and follow the same validate-or-throw parsing.
- **Analyzer access** (`/analyze`) is injected into the story service, the same way the LLM provider is injected into the comprehension service, so tests use a fake.

### 1. Recap + streak

- **New table: daily activity.** One row per (local date, kind), kind ∈ {`practice`, `episode`}, unique on the pair. Written when a Practice session finishes (last item answered, Retry included) and when an Episode is marked read. Idempotent: a second session on the same day writes nothing new.
- **Streak** = count of consecutive local days with ≥ 1 activity row, ending today if today has a row, otherwise ending yesterday (today in progress never breaks it).
- **Recap service** (deep module, one entry point): given the DB and a date, return `{ newWords, stronger: { count, examples[3] }, matured: { count, examples }, streak, practiceDone, episodeDone, complete }`. Derived from `review_log` plus daily activity; nothing stored.
  - *New words*: distinct lemmas whose first-ever `review_log` row on any track falls on that day.
  - *Stronger*: distinct lemmas with ≥ 1 review that day where stability after > stability before. Examples: the 3 with the largest increase.
  - *Matured*: distinct lemmas with ≥ 1 review that day where stability before < 21 and after ≥ 21, on any track (**Mature** is per track; the count is per lemma).
- **Slot line**: the same service scoped to one source (a Practice session's reviews or an Episode's newly met lemmas) renders the one-liner. Practice's line comes from its session's reviews; an episode's line counts lemmas from that episode that are new to the store.
- **UI**: home shows today's two items with done state and the streak. The Practice end screen and the episode "read" action show the slot line. When both are done, the full recap screen opens once; it is reachable from home for the rest of the day. All copy Italian.
- **Schema change: `review_log` gains nullable `stability_before` / `stability_after`** (today it logs only the FSRS state enum). Written on every grade from now on. Rows from before the migration have nulls and never count as stronger or matured; first-review detection works on all rows.

### 2. Story + Episodes

- **New table: story.** id, premise (title + hook), outline (LLM JSON: plot sketch, characters, per-episode beats), planned episode count (1–10, clamped), status ∈ {`active`, `finished`, `abandoned`}, created/ended timestamps. At most one `active` row.
- **Episode = `source_text` row** plus a link to (story id, episode number), as a new nullable column pair on `source_text` or a small join table, whichever fits the schema better. It also gets `read_at`. Episodes go through the normal import pipeline (`/analyze` → `persistAnalysis`) so tokens, lemmas and MWEs are identical to a pasted text.
- **Story service interface** (the seam; provider and analyzer injected):
  - `proposePremises()`: 3 premises, not persisted (reroll = call again).
  - `startStory(premise)`: outline call, persists the story, generates episode 1 synchronously (the one visible wait, at story start).
  - `currentEpisode()`: the unread episode of the active story; if it's missing (background failure), generate it now.
  - `markEpisodeRead(textId)`: sets `read_at`, writes the daily-activity row, then kicks off background generation of episode N+1 unless N is the planned last, in which case the story is set `finished`.
  - `abandonStory()`: status `abandoned`; episodes stay as texts.
- **Episode generation prompt** gets: outline, all previous episode texts of this story, episode number and planned total, known-lemma list (lemmas with any knowledge row), target ~150 words, ~10% new lemmas, Italian-native learner, sub-A1 grammar kept simple.
- **Level check**: analyze the draft, compute share of content lemmas not in the known set; accept within 5–15%, else regenerate, max 2 retries, then accept the closest draft. (Target and tolerance are constants beside the service.)
- **Comprehension check** finishing calls `markEpisodeRead` for episode texts; for plain texts it stays as today.
- **UI**: a Read entry on home → active story's current episode in the existing reader route with a story header ("<titolo> · episodio N di M"); no active story → premise picker with reroll. Story page lists the current story's episodes. The end of the final episode shows a "Storia completata" screen, then the picker.

### 3. Passage exercise

- **New exercise plugin `passage`** under the exercise contract (ADR-0003), tracks: `[receptive]`, modality text prompt / choice answer. `appliesTo` requires a cached passage question for the lemma.
- **New table: passage question.** lemma id, passage text (2–3 sentences), source (`text` with source_text id, or `generated`), question (Italian), choices (3–4), answer index, provider, created. Disposable derived data like comprehension questions (no manual tier). Several rows per lemma allowed; the session picks one at random.
- **Passage question service** (seam; provider injected):
  - `preparePassages(db, lemmaIds)`: for each lemma lacking a cached row, take up to 3 consecutive sentences from read texts containing the lemma (prefer the shortest that contains it; token table), else ask the LLM for a short passage built from known lemmas; then one LLM call writes the question. Junk response → nothing cached.
  - Triggered in the background after a Practice session finishes, for receptive dues of the next 2 days that lack a passage, capped per run (constant, start at 20) to bound LLM use.
- **Session build**: in the receptive queue, for each due lemma: context-bound → Passage if applicable, else skipped as today; otherwise if both MCQ and Passage apply, pick one 50/50; otherwise whichever applies. Session build stays LLM-free.
- **Context-bound lemmas** stop being excluded from the receptive queue when they have a passage: they get no MCQ, ever.
- **Grading, Retry, report**: identical to recognition MCQ: binary rating, missed items join the Retry, report flags the item for maintenance (report on a passage deletes its cached question so it is regenerated).
- **Client item** strips the answer index (contract rule); the target word is highlighted in the passage, not glossed.

## Testing Decisions

- Good tests drive the public entry point of a module against an in-memory migrated SQLite DB and assert on returned values and persisted rows, never on internal helpers. LLM and analyzer are replaced by fakes injected at the service boundary; fakes count calls.
- **Recap service**: seed `review_log` rows (null-stability legacy rows, first-ever review, stability increase, crossing 21 on one and two tracks, reviews on other days) and daily-activity rows; assert counts, examples order, per-lemma dedup, streak with/without today, gap reset, `complete` flag. Prior art: practice session tests' seeding helpers, FSRS tests.
- **Daily activity writes**: through the existing Practice seam (`buildSession` → `answerItem` to the end), assert one `practice` row, idempotent on a second session.
- **Story service**: fake provider returns premises / outline / episode drafts; fake analyzer returns lemma lists. Assert: start persists story + episode 1 as a `source_text` with tokens; level check regenerates on 30% new and accepts on 10%, gives up after 2 retries; `markEpisodeRead` writes activity, sets `read_at`, generates N+1, finishes the story at the planned last; clamps planned count to 10; `abandonStory` keeps texts; only one active story. Prior art: comprehension service tests (provider stub, call counting), import pipeline tests.
- **Prompt builders / parsers**: pure-function tests for malformed JSON, wrong choice counts, out-of-range episode counts. Prior art: `llm/provider` tests.
- **Passage**: plugin test for generate/toClient/grade (toClient never leaks the answer). Prior art: recognition-mcq tests. Session tests: context-bound lemma with a passage gets Passage and never MCQ; without a passage it's skipped; with both applicable both kinds appear across seeds (inject the random source); no provider calls during build. Passage service test: real sentence preferred over generated; generated fallback when no sentence; junk response caches nothing.

## Out of Scope

- Per-track split in the recap; history/stats view beyond today.
- Adaptive new-word ratio (driven by comprehension scores).
- Gating the episode behind Practice, badges, bonus episodes, quests.
- Multiple concurrent stories, story editing, regenerating a single episode on request.
- Story audio beyond the reader's existing listen button.
- Stability-based MCQ/Passage selection (random only for now).
- Notifications or in-app nagging: the phone alarm stays the trigger.
- Changes to the 3-slot wording in older roadmap sections beyond what was already updated.

## Further Notes

- The known-lemma list for episode N+1 is one day stale (generated when N is read). Accepted at 10% new.
- Episode 1 is the only synchronous LLM wait in the whole slice; premises are a cheap call.
- If passage questions keep being reported, the escape hatch is the same as comprehension checks: delete and regenerate; the data is disposable.
- After Slice 0.5 ships, watch: does the learner read an episode most days? If not, revisit gating the episode (option rejected 2026-10-14).
