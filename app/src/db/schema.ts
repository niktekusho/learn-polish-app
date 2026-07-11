import { relations } from "drizzle-orm";
import {
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
// derivable by scanning `token`; the gap is deliberate for the MVP — not modeled.
// ---------------------------------------------------------------------------

/** An imported document the user pasted in (#4 fills these). */
export const sourceText = sqliteTable("source_text", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title"),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** The dictionary/base form. The unit knowledge is tracked against. */
export const lemma = sqliteTable(
  "lemma",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    lemma: text("lemma").notNull(),
    pos: text("pos").notNull(), // UPOS: NOUN, VERB, ADP, ...
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
    track: text("track", { enum: ["receptive", "productive"] }).notNull(),
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
    track: text("track", { enum: ["receptive", "productive"] }).notNull(),
    rating: integer("rating").notNull(), // ts-fsrs Rating (1 Again .. 4 Easy)
    stateBefore: integer("state_before").notNull(), // FSRS State before grade
    stateAfter: integer("state_after").notNull(), // FSRS State after grade
    reviewedAt: integer("reviewed_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("review_log_lemma_idx").on(t.lemmaId, t.track),
    index("review_log_reviewed_idx").on(t.reviewedAt),
  ],
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
    provider: text("provider", { enum: ["stub", "claude-cli", "ollama", "api"] })
      .notNull()
      .default("stub"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("gloss_lemma_sense_uq").on(t.lemmaId, t.sense)],
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
