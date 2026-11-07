# Conversation lines are analyzed, not stored as tokens

The word panel opens on any word of a revealed **Conversation** character line, but the line's words get no `token` rows. `token` belongs to a `source_text`, and a `source_text` per Conversation would show up wherever texts are listed or reprocessed: the library, the maintenance repairs, practice sentences. So `words(id, turn)` in the Conversation service runs the line through `analyze` when the learner reveals it, classifies each token as the import pipeline does (`tokenLemma`), upserts its lemma and returns panel tokens with `id: null`. Nothing about the analysis is cached: revealing the line again analyzes it again.

## Considered options

- **A `source_text` per Conversation, with the lines as its tokens**: the word panel would work unchanged, Occurrence glosses included, but every reader of `source_text` and `token` would need a filter to keep Conversations out.
- **A nullable `token.text_id` plus a Conversation turn column**: keeps texts clean, but touches the most-joined table and every query that assumes a token has a text.

## Consequences

- A word on a Conversation line shows the lemma's **Gloss** and no **Occurrence gloss**: Occurrence glosses are cached per token row (`occurrence_gloss.token_id`), so the panel asks for the lemma gloss only. A Formula cannot be promoted from a Conversation line for the same reason.
- Analyzing a line upserts `lemma` rows but writes no knowledge row. A lemma enters practice only when something grades it: the panel's Known/Learning buttons, or Conversation grading.
- Conversation grading (the learner's transcripts) follows the same rule: `analyze` the text, keep it out of `token`.
