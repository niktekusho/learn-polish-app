import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { gloss, occurrenceGloss } from "#/db/schema";
import { promoteFormula } from "#/dictionary/formula";
import { lookupDictionary, senseKey } from "#/dictionary/service";
import { FORMULA_POS } from "#/import/classify";
import { getGlossProvider } from "#/llm/index";
import type { GlossProvider, OccurrenceResult, SenseGlossResult } from "#/llm/provider";
import { isName } from "#/reader/name";

type DB = BetterSQLite3Database<typeof schema>;

// Cap on how many Wiktionary senses one LLM call translates. Pathological
// entries (być, mieć) have dozens; senses beyond the cap get an Italian
// gloss only via a later regenerate.
const MAX_SENSES = 12;

export interface GlossResult {
  italian: string | null; // the lemma's gloss; null = not cached and no context to generate from
  occurrence: string | null; // what the clicked occurrence means; null without a token or on failure
  occurrenceError?: string; // why the occurrence gloss (or its formula promotion) failed
  formula?: { lemmaId: number; lemma: string; pos: string }; // the unit the token was promoted to
  cached: boolean; // true = served from cache (no provider call)
}

export interface GlossInput {
  lemmaId: number;
  lemma: string;
  pos: string;
  sentence: string;
  // The clicked occurrence.
  token?: { id: number; surface: string };
}

// The occurrence's meaning: a dictionary sense, or free Italian.
type Meaning =
  | { sense: string }
  | { sense: null; italian: string; fixed: boolean; note: string | null };

/**
 * Italian gloss for a lemma, cached in the `gloss` table, and the occurrence
 * gloss of the clicked token (CONTEXT.md "Occurrence gloss").
 *
 * Sentence context is MANDATORY to generate (#6): a context-free gloss written
 * to the cache would become *the* gloss for that lemma forever, defeating the
 * disambiguation design. So a caller with no sentence (e.g. Practice) reads the
 * cache only — a miss returns { italian: null } and writes nothing. The cache
 * row records which provider produced it, so stub output can be purged later.
 *
 * The lemma gloss is ALWAYS the sense='' row, and stays a dictionary sense.
 * When the lemma is in the home dictionary and the provider supports it, the
 * hybrid path (ADR-0002) fills the cache in one call: every Wiktionary sense
 * gets a per-sense row (sense = senseKey(english)), the sense the LLM flags as
 * fitting the sentence is copied into sense='', and the occurrence answer
 * rides along. Later occurrences cost one occurrence call each. Out-of-
 * dictionary lemmas keep the sentence-context path below (sense='').
 */
export async function getGloss(
  db: DB,
  input: GlossInput,
  provider: GlossProvider = getGlossProvider(),
): Promise<GlossResult> {
  // A Name has no Italian meaning to learn (CONTEXT.md "Name").
  if (isName(input.pos)) return { italian: null, occurrence: null, cached: false };
  const cached = lemmaGloss(db, input.lemmaId);
  const occurrence = input.token ? cachedOccurrence(db, input.token.id, input.lemmaId) : null;
  if (cached !== null && (!input.token || occurrence !== null)) {
    return { italian: cached, occurrence, cached: true };
  }

  const sentence = input.sentence.trim();
  if (!sentence) return { italian: cached, occurrence: null, cached: false }; // read-only, no context

  const senses = provider.glossSenses
    ? lookupDictionary(db, input.lemma, input.pos, input.lemmaId)
        .entries.flatMap((e) => e.senses)
        .slice(0, MAX_SENSES)
    : [];
  const surface = input.token?.surface.trim() ?? input.lemma;
  const req = { ...input, sentence, surface };

  if (cached === null) {
    const meaning =
      senses.length > 0
        ? await glossFromSenses(db, req, senses, provider)
        : await glossFromSentence(db, req, provider);
    if (!input.token)
      return { italian: lemmaGloss(db, input.lemmaId), occurrence: null, cached: false };
    return saveOccurrence(db, input, input.token, meaning, senses.length > 0, provider);
  }

  // Only senses with an Italian gloss can be pointed to.
  const offered = senses.flatMap((s) =>
    s.italian ? [{ gloss: s.gloss, italian: s.italian }] : [],
  );
  if (!provider.glossOccurrence || !input.token) {
    return { italian: cached, occurrence: null, cached: true };
  }
  let answer: OccurrenceResult;
  try {
    answer = await provider.glossOccurrence({
      ...req,
      senses: offered.map((s, index) => ({ index, ...s })),
    });
  } catch (err) {
    console.error(
      `[gloss] provider "${provider.name}" failed the occurrence of lemma "${input.lemma}" (token ${input.token.id}):`,
      err,
    );
    return {
      italian: cached,
      occurrence: null,
      occurrenceError: `Provider "${provider.name}": ${errorMessage(err)}`,
      cached: true,
    };
  }
  return saveOccurrence(
    db,
    input,
    input.token,
    toMeaning(answer, offered),
    offered.length > 0,
    provider,
  );
}

/**
 * Cache the occurrence gloss. A fixed use of an inflected form that no
 * dictionary sense fits is promoted to a Formula instead (CONTEXT.md "Formula").
 */
async function saveOccurrence(
  db: DB,
  input: GlossInput,
  tok: { id: number; surface: string },
  meaning: Meaning,
  hasSenses: boolean,
  provider: GlossProvider,
): Promise<GlossResult> {
  const inflected = tok.surface.trim().toLowerCase() !== input.lemma.toLowerCase();
  const word = input.pos !== "MWE" && input.pos !== FORMULA_POS;
  if (meaning.sense === null && meaning.fixed && hasSenses && inflected && word) {
    try {
      const formula = await promoteFormula(db, provider, {
        tokenId: tok.id,
        surface: tok.surface,
        italian: meaning.italian,
        note: meaning.note,
      });
      if (formula) {
        return {
          italian: lemmaGloss(db, formula.lemmaId),
          occurrence: meaning.italian,
          formula,
          cached: false,
        };
      }
    } catch (err) {
      return {
        italian: lemmaGloss(db, input.lemmaId),
        occurrence: null,
        occurrenceError: errorMessage(err),
        cached: false,
      };
    }
  }

  const italian =
    meaning.sense === null
      ? meaning.italian
      : (senseGloss(db, input.lemmaId, meaning.sense) ?? lemmaGloss(db, input.lemmaId)!);
  db.insert(occurrenceGloss)
    .values({
      tokenId: tok.id,
      lemmaId: input.lemmaId,
      sense: meaning.sense,
      italian,
      provider: provider.name,
    })
    .onConflictDoNothing()
    .run();
  return {
    italian: lemmaGloss(db, input.lemmaId),
    occurrence: cachedOccurrence(db, tok.id, input.lemmaId),
    cached: false,
  };
}

/** Sentence-context glossing for out-of-dictionary lemmas: the answer is free text. */
async function glossFromSentence(
  db: DB,
  input: GlossInput,
  provider: GlossProvider,
): Promise<Meaning> {
  let italian: string;
  try {
    italian = await provider.gloss({
      lemma: input.lemma,
      pos: input.pos,
      sentence: input.sentence,
    });
  } catch (err) {
    // Log server-side (the pnpm dev terminal) — the error otherwise only
    // surfaces as the panel's generic "failed" state, hiding the real cause
    // (e.g. `claude exited 1: 401 Invalid authentication credentials`).
    console.error(
      `[gloss] provider "${provider.name}" failed for lemma "${input.lemma}" (id ${input.lemmaId}):`,
      err,
    );
    throw err;
  }
  db.insert(gloss)
    .values({
      lemmaId: input.lemmaId,
      sense: "",
      italian,
      provider: provider.name,
    })
    .onConflictDoNothing()
    .run();
  return { sense: null, italian, fixed: false, note: null };
}

/**
 * Hybrid per-sense glossing: ONE provider call translates all senses, flags
 * the one fitting the sentence and answers for the occurrence. All writes
 * land in one transaction so a junk response caches nothing.
 * onConflictDoNothing everywhere: existing rows (manual per-sense edits,
 * racing inserts) always win.
 */
async function glossFromSenses(
  db: DB,
  input: GlossInput & { surface: string },
  senses: { gloss: string }[],
  provider: GlossProvider,
): Promise<Meaning> {
  let result: SenseGlossResult;
  try {
    result = await provider.glossSenses!({
      lemma: input.lemma,
      pos: input.pos,
      surface: input.surface,
      sentence: input.sentence,
      senses: senses.map((s, index) => ({ index, gloss: s.gloss })),
    });
  } catch (err) {
    console.error(
      `[gloss] provider "${provider.name}" failed sense-glossing lemma "${input.lemma}" (id ${input.lemmaId}):`,
      err,
    );
    throw err;
  }

  const best = result.translations.find((t) => t.index === result.bestIndex)!;
  db.transaction((tx) => {
    for (const t of result.translations) {
      tx.insert(gloss)
        .values({
          lemmaId: input.lemmaId,
          sense: senseKey(senses[t.index].gloss),
          italian: t.italian,
          provider: provider.name,
        })
        .onConflictDoNothing()
        .run();
    }
    tx.insert(gloss)
      .values({
        lemmaId: input.lemmaId,
        sense: "",
        italian: best.italian,
        provider: provider.name,
      })
      .onConflictDoNothing()
      .run();
  });
  return toMeaning(result.occurrence, senses);
}

function toMeaning(answer: OccurrenceResult, senses: { gloss: string }[]): Meaning {
  return "index" in answer
    ? { sense: senseKey(senses[answer.index].gloss) }
    : { sense: null, ...answer };
}

function lemmaGloss(db: DB, lemmaId: number): string | null {
  return senseGloss(db, lemmaId, "");
}

function senseGloss(db: DB, lemmaId: number, sense: string): string | null {
  const [row] = db
    .select({ italian: gloss.italian })
    .from(gloss)
    .where(and(eq(gloss.lemmaId, lemmaId), eq(gloss.sense, sense)))
    .all();
  return row?.italian ?? null;
}

function cachedOccurrence(db: DB, tokenId: number, lemmaId: number): string | null {
  const [row] = db
    .select({ italian: occurrenceGloss.italian })
    .from(occurrenceGloss)
    .where(and(eq(occurrenceGloss.tokenId, tokenId), eq(occurrenceGloss.lemmaId, lemmaId)))
    .all();
  return row?.italian ?? null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Overwrite the default-sense gloss for a lemma with a learner-written value.
 * Recorded as provider 'manual' — the highest-trust tier, which purge and
 * regenerate never touch. Trims and rejects empty input.
 */
export function setManualGloss(db: DB, lemmaId: number, italian: string): string {
  const value = italian.trim();
  if (!value) throw new Error("manual gloss cannot be empty");
  db.insert(gloss)
    .values({ lemmaId, sense: "", italian: value, provider: "manual" })
    .onConflictDoUpdate({
      target: [gloss.lemmaId, gloss.sense],
      set: { italian: value, provider: "manual" },
    })
    .run();
  return value;
}

/**
 * Discard ALL cached glosses for the lemma (default-sense, per-sense and
 * occurrence) and generate fresh. The explicit user "regenerate" action — so it overwrites
 * even manual glosses, consistent with the pre-kaikki semantics.
 */
export async function regenerateGloss(
  db: DB,
  input: GlossInput,
  provider: GlossProvider = getGlossProvider(),
): Promise<GlossResult> {
  db.delete(gloss).where(eq(gloss.lemmaId, input.lemmaId)).run();
  db.delete(occurrenceGloss).where(eq(occurrenceGloss.lemmaId, input.lemmaId)).run();
  return getGloss(db, input, provider);
}
