import { relations, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Vocab store (backlog #3). Model per CONTEXT.md:
//   surface form -> token, lemma = tracked unit, knowledge = per-track FSRS,
//   gloss = Italian meaning cached per lemma/sense.
// ponytail: CONTEXT's "tracked unit = lemma + surface forms encountered" is
// derivable by scanning `token`; the gap is deliberate for the MVP: not modeled.
// ---------------------------------------------------------------------------

/**
 * An LLM-written serial (CONTEXT.md "Story"). Its episodes are source_text
 * rows. At most one story is active.
 */
export const story = sqliteTable(
  "story",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    genre: text("genre").notNull(),
    hook: text("hook").notNull(),
    // LLM outline: plot sketch, characters, one beat per planned episode.
    outline: text("outline", { mode: "json" })
      .$type<{ plot: string; characters: string[]; beats: string[] }>()
      .notNull(),
    plannedEpisodes: integer("planned_episodes").notNull(), // 1..10
    status: text("status", { enum: ["active", "finished", "abandoned"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    endedAt: integer("ended_at", { mode: "timestamp" }),
  },
  (t) => [
    uniqueIndex("story_one_active_uq")
      .on(t.status)
      .where(sql`status = 'active'`),
  ],
);

/** An imported document: pasted by the user, or a story Episode. */
export const sourceText = sqliteTable(
  "source_text",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title"),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    // Set on Episodes only.
    storyId: integer("story_id").references(() => story.id),
    episodeNumber: integer("episode_number"),
    readAt: integer("read_at", { mode: "timestamp" }),
  },
  (t) => [uniqueIndex("source_text_story_episode_uq").on(t.storyId, t.episodeNumber)],
);

/** The dictionary/base form. The unit knowledge is tracked against. */
export const lemma = sqliteTable(
  "lemma",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lemma: text("lemma").notNull(),
    // UPOS (NOUN, VERB, ADP, ...), or 'MWE' for multi-word tracked units
    // (dictionary headwords detected at import, see mweOccurrence).
    pos: text("pos").notNull(),
    // A wrong Report (CONTEXT.md "Report"): kept out of practice until its Report review.
    flaggedAt: integer("flagged_at", { mode: "timestamp" }),
    flagNote: text("flag_note"),
    // The token a reader Report was made on: its text's same-form tokens are Name candidates.
    flagTokenId: integer("flag_token_id").references((): AnySQLiteColumn => token.id, {
      onDelete: "set null",
    }),
    // Meaning only exists in a sentence (CONTEXT.md "Context-bound lemma"):
    // never asked as a single word, still read aloud.
    contextBound: integer("context_bound", { mode: "boolean" }).notNull().default(false),
    // MWEs and Formulas only (CONTEXT.md "Suppressed MWE", "Suppressed formula"):
    // never detected at import.
    suppressed: integer("suppressed", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    // A lemma is identified by its base form + POS (kot/NOUN vs homographs).
    uniqueIndex("lemma_lemma_pos_uq").on(t.lemma, t.pos),
    index("lemma_lemma_idx").on(t.lemma),
  ],
);

/** A surface form as it appears in a text, in reading order. */
export const token = sqliteTable(
  "token",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    textId: integer("text_id")
      .notNull()
      .references(() => sourceText.id, { onDelete: "cascade" }),
    // null for whitespace/layout tokens and unlemmatizable punctuation.
    lemmaId: integer("lemma_id").references(() => lemma.id),
    surface: text("surface").notNull(),
    position: integer("position").notNull(), // token index within the text
    sentenceIndex: integer("sentence_index").notNull(),
    isSpace: integer("is_space", { mode: "boolean" }).notNull().default(false),
    // Sidecar morph features ("Case=Gen", "Number=Sing"); null when the text
    // has not been analyzed with tags yet.
    tags: text("tags", { mode: "json" }).$type<string[]>(),
  },
  (t) => [
    index("token_text_idx").on(t.textId, t.position),
    index("token_lemma_idx").on(t.lemmaId),
    // "lemma by surface form" lookup.
    index("token_surface_idx").on(t.surface),
  ],
);

/** FSRS memory state, one row per (lemma, track). See ADR-0003. */
export const knowledge = sqliteTable(
  "knowledge",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lemmaId: integer("lemma_id")
      .notNull()
      .references(() => lemma.id, { onDelete: "cascade" }),
    // No CHECK constraint in SQLite: a new track is a TS-only change (ADR-0005).
    track: text("track", { enum: ["receptive", "productive", "pronunciation"] }).notNull(),
    // ts-fsrs Card fields (learning_steps added in #8).
    stability: real("stability").notNull().default(0),
    difficulty: real("difficulty").notNull().default(0),
    due: integer("due", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastReview: integer("last_review", { mode: "timestamp" }),
    // FSRS State enum: 0 New, 1 Learning, 2 Review, 3 Relearning.
    state: integer("state").notNull().default(0),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    elapsedDays: integer("elapsed_days").notNull().default(0),
    scheduledDays: integer("scheduled_days").notNull().default(0),
    learningSteps: integer("learning_steps").notNull().default(0),
  },
  (t) => [
    uniqueIndex("knowledge_lemma_track_uq").on(t.lemmaId, t.track),
    // "due lemmas" query: filter by track, order by due.
    index("knowledge_track_due_idx").on(t.track, t.due),
  ],
);

/**
 * Append-only history of every grade. Required from day 1: FSRS parameter
 * optimization needs the full review history and it can't be reconstructed
 * from the current knowledge state later. #8 writes a row per grade.
 */
export const reviewLog = sqliteTable(
  "review_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lemmaId: integer("lemma_id")
      .notNull()
      .references(() => lemma.id, { onDelete: "cascade" }),
    // No CHECK constraint in SQLite: a new track is a TS-only change (ADR-0005).
    track: text("track", { enum: ["receptive", "productive", "pronunciation"] }).notNull(),
    rating: integer("rating").notNull(), // ts-fsrs Rating (1 Again .. 4 Easy)
    stateBefore: integer("state_before").notNull(), // FSRS State before grade
    stateAfter: integer("state_after").notNull(), // FSRS State after grade
    // FSRS stability around the grade, for the daily recap. Null on rows
    // written before the columns existed: those never count as stronger/matured.
    stabilityBefore: real("stability_before"),
    stabilityAfter: real("stability_after"),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("review_log_lemma_idx").on(t.lemmaId, t.track),
    index("review_log_reviewed_idx").on(t.reviewedAt),
  ],
);

/**
 * What the learner finished on a local calendar day: one row per (day, kind).
 * Feeds the streak and the daily recap.
 */
export const dailyActivity = sqliteTable(
  "daily_activity",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    day: text("day").notNull(), // local date, YYYY-MM-DD
    kind: text("kind", { enum: ["practice", "episode"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("daily_activity_day_kind_uq").on(t.day, t.kind)],
);

/**
 * The Learner profile (CONTEXT.md): Italian facts the learner plays themself from in a
 * Conversation. The check on `id` keeps it to one row.
 */
export const learnerProfile = sqliteTable(
  "learner_profile",
  {
    id: integer("id").primaryKey().default(1),
    name: text("name").notNull(),
    job: text("job").notNull(),
    city: text("city").notNull(),
    partner: text("partner").notNull(),
    hobbies: text("hobbies").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [check("learner_profile_single_row", sql`${t.id} = 1`)],
);

/**
 * A Conversation (CONTEXT.md): a role-play set right after an Episode, played toward a Goal.
 * Written by the scene preparation call; one per Episode.
 */
export const conversation = sqliteTable("conversation", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  storyId: integer("story_id")
    .notNull()
    .references(() => story.id, { onDelete: "cascade" }),
  episodeId: integer("episode_id")
    .notNull()
    .unique()
    .references(() => sourceText.id, { onDelete: "cascade" }),
  character: text("character").notNull(), // the name, as storyCharacters gives it
  characterLine: text("character_line").notNull(), // the outline line that describes them
  scene: text("scene").notNull(), // Italian: where and when
  // Goal steps in card order; tickedTurn is the learner turn that ticked the step.
  steps: text("steps", { mode: "json" })
    .$type<{ id: string; text: string; tickedTurn: number | null }[]>()
    .notNull(),
  roleFacts: text("role_facts"), // the facts of a role the Goal assigns, in Italian
  // The character's opening line and the first Hint pair.
  opening: text("opening", { mode: "json" })
    .$type<{ line: string; italian: string; hint: string[]; modelLine: string }>()
    .notNull(),
  // Due Productive lemmas captured when the scene was prepared.
  dueLemmas: text("due_lemmas", { mode: "json" }).$type<string[]>().notNull(),
  status: text("status", { enum: ["open", "debriefed"] })
    .notNull()
    .default("open"),
  turnCount: integer("turn_count").notNull().default(0), // learner turns
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** One learner turn and the character's reply. The reply columns stay null until it arrives. */
export const conversationTurn = sqliteTable(
  "conversation_turn",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),
    turn: integer("turn").notNull(), // 1 for the learner's first turn
    learnerText: text("learner_text").notNull(), // the transcript
    line: text("line"),
    italian: text("italian"),
    understood: integer("understood", { mode: "boolean" }),
    stepsTicked: text("steps_ticked", { mode: "json" }).$type<string[]>(),
    hint: text("hint", { mode: "json" }).$type<string[]>(),
    modelLine: text("model_line"),
    attempts: integer("attempts").notNull().default(0), // replies asked of the session
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("conversation_turn_uq").on(t.conversationId, t.turn)],
);

/** The Piper voice a Story character speaks with, kept across its Conversations. */
export const characterVoice = sqliteTable(
  "character_voice",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    storyId: integer("story_id")
      .notNull()
      .references(() => story.id, { onDelete: "cascade" }),
    character: text("character").notNull(),
    voice: text("voice").notNull(), // a sidecar catalog id
  },
  (t) => [uniqueIndex("character_voice_uq").on(t.storyId, t.character)],
);

/**
 * A repaired Lemma slip (CONTEXT.md), shown once to the learner as
 * "myśli → myśleć". Text, not FKs: the slip row is deleted by the repair.
 */
export const lemmaSlipRepair = sqliteTable("lemma_slip_repair", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  slip: text("slip").notNull(),
  target: text("target").notNull(),
  repairedAt: integer("repaired_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  seenAt: integer("seen_at", { mode: "timestamp" }),
});

/**
 * One call to a CLI LLM provider, kept to audit usage and tune prompts and models.
 * Rows from before the full log have null text, usage and effort.
 */
export const llmCall = sqliteTable("llm_call", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  provider: text("provider").notNull(),
  call: text("call").notNull(), // e.g. "episode", "proofread"
  model: text("model").notNull(),
  effort: text("effort"),
  promptChars: integer("prompt_chars").notNull(),
  prompt: blob("prompt", { mode: "buffer" }), // gzip
  response: blob("response", { mode: "buffer" }), // gzip; raw CLI output when no reply could be read
  // Includes the cached part, so input_tokens - cache_read_tokens is what the call paid in full.
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  apiMs: integer("api_ms"),
  ms: integer("ms").notNull(),
  error: text("error"), // null when the output parsed
  // Conversation turns only: the learner turn answered (0 for an opening) and which try.
  conversationId: integer("conversation_id").references(() => conversation.id, {
    onDelete: "set null",
  }),
  turn: integer("turn"),
  attempt: integer("attempt"),
});

/**
 * One Report review (CONTEXT.md): the primary gloss and Context-bound mark
 * before and after, so the learner can see and undo it.
 */
export const reportReview = sqliteTable(
  "report_review",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Null once a Name decision left the lemma without tokens and deleted it.
    lemmaId: integer("lemma_id").references(() => lemma.id, { onDelete: "set null" }),
    word: text("word").notNull(),
    note: text("note"),
    glossBefore: text("gloss_before"),
    glossProviderBefore: text("gloss_provider_before", {
      enum: ["stub", "claude-cli", "codex-cli", "ollama", "api", "manual"],
    }),
    glossAfter: text("gloss_after"),
    markBefore: integer("mark_before", { mode: "boolean" }).notNull(),
    markAfter: integer("mark_after", { mode: "boolean" }).notNull(),
    reason: text("reason").notNull(),
    // Tokens the review moved to a Name, with the lemma each came from.
    names: text("names", { mode: "json" })
      .$type<{ tokenId: number; lemma: string; pos: string; name: string }[]>()
      .notNull()
      .default([]),
    reviewedAt: integer("reviewed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    seenAt: integer("seen_at", { mode: "timestamp" }),
    undoneAt: integer("undone_at", { mode: "timestamp" }),
  },
  (t) => [index("report_review_lemma_idx").on(t.lemmaId)],
);

/** Italian gloss cached per lemma (optionally per sense). See ADR-0002. */
export const gloss = sqliteTable(
  "gloss",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lemmaId: integer("lemma_id")
      .notNull()
      .references(() => lemma.id, { onDelete: "cascade" }),
    sense: text("sense").notNull().default(""), // '' = the default/only sense
    italian: text("italian").notNull(),
    // Which provider produced this gloss, so stub output written during
    // development can be found and purged when a real provider lands.
    // 'manual' = learner-written; highest trust, never auto-purged/regenerated.
    provider: text("provider", {
      enum: ["stub", "claude-cli", "codex-cli", "ollama", "api", "manual"],
    })
      .notNull()
      .default("stub"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("gloss_lemma_sense_uq").on(t.lemmaId, t.sense)],
);

/**
 * What one occurrence means in its sentence (CONTEXT.md "Occurrence gloss"),
 * cached per (token, unit). An MWE occurrence is keyed by its first token.
 */
export const occurrenceGloss = sqliteTable(
  "occurrence_gloss",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tokenId: integer("token_id")
      .notNull()
      .references(() => token.id, { onDelete: "cascade" }),
    lemmaId: integer("lemma_id")
      .notNull()
      .references(() => lemma.id, { onDelete: "cascade" }),
    // senseKey of the fitting dictionary sense; null = free Italian, no sense fits.
    sense: text("sense"),
    italian: text("italian").notNull(),
    provider: text("provider", {
      enum: ["stub", "claude-cli", "codex-cli", "ollama", "api", "manual"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex("occurrence_gloss_token_lemma_uq").on(t.tokenId, t.lemmaId),
    index("occurrence_gloss_lemma_idx").on(t.lemmaId),
  ],
);

/**
 * Cached comprehension-check questions (roadmap "Comprehension checks"), one
 * row per question, cache key = textId. Disposable derived data: no manual
 * tier, regenerate = delete + re-generate. Learner responses are NOT stored:
 * only the answer key is, as part of the cached question.
 */
export const comprehensionQuestion = sqliteTable(
  "comprehension_question",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    textId: integer("text_id")
      .notNull()
      .references(() => sourceText.id, { onDelete: "cascade" }),
    questionIndex: integer("question_index").notNull(), // order within the check
    question: text("question").notNull(), // Italian
    // 3–4 Italian choices. No .default: the service always supplies the array.
    choices: text("choices", { mode: "json" }).$type<string[]>().notNull(),
    correctIndex: integer("correct_index").notNull(), // the persisted answer key
    provider: text("provider", {
      enum: ["stub", "claude-cli", "codex-cli", "ollama", "api", "manual"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("cq_text_question_uq").on(t.textId, t.questionIndex)],
);

/**
 * Prepared Passage-exercise questions, several allowed per lemma. Disposable
 * derived data like comprehension questions: a report deletes the row.
 */
export const passageQuestion = sqliteTable(
  "passage_question",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lemmaId: integer("lemma_id")
      .notNull()
      .references(() => lemma.id, { onDelete: "cascade" }),
    passage: text("passage").notNull(),
    target: text("target").notNull(),
    // Cut from a read text (textId).
    source: text("source", { enum: ["text"] }).notNull(),
    textId: integer("text_id").references(() => sourceText.id, { onDelete: "set null" }),
    question: text("question").notNull(), // Italian
    choices: text("choices", { mode: "json" }).$type<string[]>().notNull(),
    correctIndex: integer("correct_index").notNull(),
    provider: text("provider", {
      enum: ["stub", "claude-cli", "codex-cli", "ollama", "api", "manual"],
    }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("passage_question_lemma_idx").on(t.lemmaId)],
);

// ---------------------------------------------------------------------------
// Home dictionary (ADR-0002): kaikki.org Polish JSONL imported into SQLite.
// Bulk-replaced on re-import; never referenced by FK from learner data
// (lemma/gloss/knowledge), so a wipe+reload is always safe.
// ---------------------------------------------------------------------------

/** One kaikki entry: a headword + POS (one row per etymology section). */
export const dictEntry = sqliteTable(
  "dict_entry",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    word: text("word").notNull(), // headword as in the dump
    pos: text("pos").notNull(), // kaikki code: 'noun' | 'verb' | 'adj' | ...
    ipa: text("ipa"), // first sounds[].ipa, null if absent
    etymology: text("etymology"), // etymology_text, null if absent
    // Headword contains a space => MWE candidate for lookup-based detection.
    isMwe: integer("is_mwe", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    // NOT unique(word,pos): the dump legitimately has multiple entries per
    // (word,pos): one per etymology section.
    index("dict_entry_word_pos_idx").on(t.word, t.pos),
    index("dict_entry_mwe_idx").on(t.isMwe),
  ],
);

/** One sense (meaning) of a dict entry. Form-of/alt-of senses are skipped. */
export const dictSense = sqliteTable(
  "dict_sense",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entryId: integer("entry_id")
      .notNull()
      .references(() => dictEntry.id, { onDelete: "cascade" }),
    senseIndex: integer("sense_index").notNull(), // order within the entry
    gloss: text("gloss").notNull(), // English; last senses[].glosses element
    rawGloss: text("raw_gloss"), // raw_glosses[0] if present
    // No .default([]): drizzle-sqlite json defaults are a footgun; the loader
    // always supplies the array.
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [index("dict_sense_entry_idx").on(t.entryId, t.senseIndex)],
);

/** One inflected form from an entry's forms[] table (grammar-drill fuel). */
export const dictForm = sqliteTable(
  "dict_form",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entryId: integer("entry_id")
      .notNull()
      .references(() => dictEntry.id, { onDelete: "cascade" }),
    form: text("form").notNull(),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [
    index("dict_form_entry_idx").on(t.entryId),
    // Reverse lookup: surface form -> entry.
    index("dict_form_form_idx").on(t.form),
  ],
);

/**
 * A contiguous MWE occurrence in a text, spanning token positions. The MWE
 * itself is a `lemma` row with pos='MWE' (first-class tracked unit per
 * CONTEXT.md); occurrences need their own table because one token.lemmaId
 * can't span tokens. Component tokens keep their own word lemmas: *pewno*
 * inside *na pewno* still counts as its own exposure (accepted v1
 * double-count).
 */
export const mweOccurrence = sqliteTable(
  "mwe_occurrence",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    textId: integer("text_id")
      .notNull()
      .references(() => sourceText.id, { onDelete: "cascade" }),
    lemmaId: integer("lemma_id") // the pos='MWE' lemma row
      .notNull()
      .references(() => lemma.id, { onDelete: "cascade" }),
    startPosition: integer("start_position").notNull(), // token.position, inclusive
    endPosition: integer("end_position").notNull(), // inclusive
    sentenceIndex: integer("sentence_index").notNull(),
  },
  (t) => [
    index("mwe_occ_text_idx").on(t.textId, t.startPosition),
    index("mwe_occ_lemma_idx").on(t.lemmaId),
  ],
);

// Relations (used by drizzle's relational query API in later issues).
export const sourceTextRelations = relations(sourceText, ({ many }) => ({
  tokens: many(token),
}));

export const lemmaRelations = relations(lemma, ({ many }) => ({
  tokens: many(token),
  knowledge: many(knowledge),
  glosses: many(gloss),
  reviews: many(reviewLog),
}));

export const tokenRelations = relations(token, ({ one }) => ({
  sourceText: one(sourceText, {
    fields: [token.textId],
    references: [sourceText.id],
  }),
  lemma: one(lemma, { fields: [token.lemmaId], references: [lemma.id] }),
}));

export const knowledgeRelations = relations(knowledge, ({ one }) => ({
  lemma: one(lemma, { fields: [knowledge.lemmaId], references: [lemma.id] }),
}));

export const reviewLogRelations = relations(reviewLog, ({ one }) => ({
  lemma: one(lemma, { fields: [reviewLog.lemmaId], references: [lemma.id] }),
}));

export const glossRelations = relations(gloss, ({ one }) => ({
  lemma: one(lemma, { fields: [gloss.lemmaId], references: [lemma.id] }),
}));

export const mweOccurrenceRelations = relations(mweOccurrence, ({ one }) => ({
  sourceText: one(sourceText, {
    fields: [mweOccurrence.textId],
    references: [sourceText.id],
  }),
  lemma: one(lemma, {
    fields: [mweOccurrence.lemmaId],
    references: [lemma.id],
  }),
}));

export const dictEntryRelations = relations(dictEntry, ({ many }) => ({
  senses: many(dictSense),
  forms: many(dictForm),
}));

export const dictSenseRelations = relations(dictSense, ({ one }) => ({
  entry: one(dictEntry, {
    fields: [dictSense.entryId],
    references: [dictEntry.id],
  }),
}));

export const dictFormRelations = relations(dictForm, ({ one }) => ({
  entry: one(dictEntry, {
    fields: [dictForm.entryId],
    references: [dictEntry.id],
  }),
}));
