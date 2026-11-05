# Episode level is counted after drafting, not given to the model as a word list

The episode prompt used to list every lemma the learner knows and ask the model to write mostly with them. The list grew with the vocabulary, and a model fitting Polish around a fixed word set wrote Italian word order and calques (_mieć zimno_ for _jest mi zimno_). The prompt now carries no word list: it asks for common Polish at a beginner's level, and the app measures the draft. It analyzes the draft, counts the share of distinct content lemmas missing from the learner's store, and accepts 10–20% (target 15%). Outside that range it redrafts with the share and the new words of the rejected draft, at most twice, and keeps the draft closest to the target. This follows the project rule "Deterministic first": the store decides the level, and the LLM only writes.

## Considered options

- The full known-word list in the prompt was the old approach. The prompt grew with the learner, and the model bent Polish to fit the list.
- A short sample of words under review still pulls the text toward a word set, and the level still needs checking afterwards.

## Consequences

- An episode costs up to three drafts before the Proofread. Logged calls and the measuring script (`app/scripts/measure-episodes.ts`) show how often the first draft lands in range.
- Reusing due words in an episode is left to chance: the count controls how many words are new, not which known words appear.
