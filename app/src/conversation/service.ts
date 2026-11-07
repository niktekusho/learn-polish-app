import { and, asc, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import {
  characterVoice,
  conversation,
  conversationTurn,
  knowledge,
  lemma,
  sourceText,
  story,
} from "#/db/schema";
import { dueLemmas } from "#/fsrs/index";
import { tokenLemma, upsertLemma } from "#/import/pipeline";
import type { AnalyzeResponse, Voice } from "#/import/sidecar";
import { buildCharacterBrief } from "#/llm/conversation-brief";
import type { ConversationSession, SessionSeed, TranscriptLine } from "#/llm/conversation-session";
import type { SceneProvider, SceneRequest } from "#/llm/provider";
import { getLearnerProfile, type LearnerProfile } from "#/profile/service";
import { knowledgeFlags } from "#/reader/knowledge";
import type { PanelToken } from "#/reader/types";
import { storyCharacters } from "#/story/character-names";

type DB = BetterSQLite3Database<typeof schema>;
type ConversationRow = typeof conversation.$inferSelect;

// Due Productive lemmas the scene is nudged toward: a few, so the Goal stays natural.
const DUE_LEMMAS = 5;

export interface ConversationDeps {
  provider: SceneProvider;
  voices: () => Promise<Voice[]>; // the sidecar's Piper catalog
  analyze: (text: string) => Promise<AnalyzeResponse>;
  createSession: (conversationId: number) => ConversationSession;
  now?: () => Date;
}

export interface ConversationView {
  id: number;
  character: string;
  voice: string;
  scene: string;
  roleFacts: string | null;
  steps: { id: string; text: string; ticked: boolean }[];
  opening: { line: string; italian: string; revealed: boolean };
  turns: { learnerText: string; line: string | null; italian: string | null; revealed: boolean }[];
}

export type CurrentConversation =
  | { needsProfile: true }
  | { needsProfile: false; conversation: ConversationView | null };

// Scene preparations in flight, per DB, keyed by Episode id: opening the screen waits on a
// running background preparation instead of starting another.
const inFlight = new WeakMap<DB, Map<number, Promise<void>>>();
// One warm session per Conversation id, per DB. A session kills its own idle process and
// respawns on the next turn, so an entry is never removed except by a reroll.
const liveSessions = new WeakMap<DB, Map<number, ConversationSession>>();

/** The Conversation seam: scene provider, sessions and clock injected so tests use fakes. */
export function conversationService(db: DB, deps: ConversationDeps) {
  const now = deps.now ?? (() => new Date());
  const running = inFlight.get(db) ?? new Map<number, Promise<void>>();
  inFlight.set(db, running);
  const sessions = liveSessions.get(db) ?? new Map<number, ConversationSession>();
  liveSessions.set(db, sessions);

  const byEpisode = (episodeId: number) =>
    db.select().from(conversation).where(eq(conversation.episodeId, episodeId)).get();

  function get(id: number): ConversationRow {
    const c = db.select().from(conversation).where(eq(conversation.id, id)).get();
    if (!c) throw new Error(`no conversation ${id}`);
    return c;
  }

  const turnsOf = (id: number) =>
    db
      .select()
      .from(conversationTurn)
      .where(eq(conversationTurn.conversationId, id))
      .orderBy(asc(conversationTurn.turn))
      .all();

  function profile(): LearnerProfile {
    const p = getLearnerProfile(db);
    if (!p) throw new Error("no Learner profile");
    return p;
  }

  function voicesOf(storyId: number): Map<string, string> {
    const rows = db.select().from(characterVoice).where(eq(characterVoice.storyId, storyId)).all();
    return new Map(rows.map((r) => [r.character, r.voice]));
  }

  /** One scene call for `episodeId`, and the row values it gives. */
  async function askScene(episodeId: number, profile: LearnerProfile) {
    const episode = db.select().from(sourceText).where(eq(sourceText.id, episodeId)).get();
    if (!episode?.storyId) throw new Error(`text ${episodeId} is not an episode`);
    const storyId = episode.storyId;
    const characters = storyCharacters(db, storyId);
    // A Story gets its voices on its first Conversation and keeps them.
    const voices = voicesOf(storyId).size === 0 ? await deps.voices() : null;
    const req: SceneRequest = {
      episode: episode.content,
      characters: characters.map((c) => c.description),
      profile,
      dueLemmas: dueLemmas(db, "productive", { now: now(), limit: DUE_LEMMAS }).map((l) => l.lemma),
      voices: voices && voices.map(({ id, label }) => ({ id, label })),
    };
    const scene = await deps.provider.scene(req);
    const character = characters[scene.character];
    return {
      voices: scene.voices?.map((voice, i) => ({ storyId, character: characters[i].name, voice })),
      row: {
        storyId,
        episodeId,
        character: character.name,
        characterLine: character.description,
        scene: scene.scene,
        steps: scene.steps.map((text, i) => ({ id: `s${i + 1}`, text, tickedTurn: null })),
        roleFacts: scene.roleFacts,
        opening: scene.opening,
        openingRevealed: false,
        dueLemmas: req.dueLemmas,
        updatedAt: now(),
      },
    };
  }

  async function writeScene(episodeId: number, profile: LearnerProfile): Promise<void> {
    const { voices, row } = await askScene(episodeId, profile);
    db.transaction((tx) => {
      if (voices) tx.insert(characterVoice).values(voices).run();
      tx.insert(conversation)
        .values({ ...row, createdAt: now() })
        .run();
    });
  }

  /**
   * Write the Conversation that follows `episodeId`, unless it exists or is being written. Without
   * a Learner profile nothing is written: the screen asks for the profile first.
   */
  function prepareScene(episodeId: number): Promise<void> {
    const pending = running.get(episodeId);
    if (pending) return pending;
    const profile = getLearnerProfile(db);
    if (!profile || byEpisode(episodeId)) return Promise.resolve();
    const job = writeScene(episodeId, profile).finally(() => running.delete(episodeId));
    running.set(episodeId, job);
    return job;
  }

  /** The last Episode read in a Story still going or finished, not one abandoned. */
  function lastReadEpisode(): number | null {
    const row = db
      .select({ id: sourceText.id })
      .from(sourceText)
      .innerJoin(story, eq(story.id, sourceText.storyId))
      .where(and(isNotNull(sourceText.readAt), ne(story.status, "abandoned")))
      .orderBy(desc(sourceText.readAt), desc(sourceText.id))
      .get();
    return row?.id ?? null;
  }

  function view(c: ConversationRow): ConversationView {
    const turns = turnsOf(c.id);
    return {
      id: c.id,
      character: c.character,
      voice: voicesOf(c.storyId).get(c.character) ?? "",
      scene: c.scene,
      roleFacts: c.roleFacts,
      steps: c.steps.map((s) => ({ id: s.id, text: s.text, ticked: s.tickedTurn !== null })),
      opening: { line: c.opening.line, italian: c.opening.italian, revealed: c.openingRevealed },
      turns: turns.map((t) => ({
        learnerText: t.learnerText,
        line: t.line,
        italian: t.italian,
        revealed: t.lineRevealed,
      })),
    };
  }

  /**
   * The Conversation after the last Episode read. Missing (the background preparation
   * failed or is still running): wait for it or prepare it now.
   */
  async function current(): Promise<CurrentConversation> {
    if (!getLearnerProfile(db)) return { needsProfile: true };
    const episodeId = lastReadEpisode();
    if (episodeId === null) return { needsProfile: false, conversation: null };
    await running.get(episodeId)?.catch(() => {});
    await prepareScene(episodeId);
    const c = byEpisode(episodeId);
    return { needsProfile: false, conversation: c ? view(c) : null };
  }

  /** A new Goal, role facts, opening and first Hint pair, before the learner's first turn. */
  async function reroll(id: number): Promise<ConversationView> {
    const c = get(id);
    if (c.turnCount > 0) throw new Error("the learner has spoken: the scene is set");
    const { row } = await askScene(c.episodeId, profile());
    db.update(conversation).set(row).where(eq(conversation.id, id)).run();
    // A session warmed on open holds the old Goal in its brief.
    sessions.get(id)?.close();
    sessions.delete(id);
    return view(get(id));
  }

  /** Store the learner's transcript as the next turn, before any reply is asked. */
  function addTurn(id: number, learnerText: string): number {
    const turn = get(id).turnCount + 1;
    if (turnsOf(id).at(-1)?.line === null) {
      throw new Error("the last turn is still waiting for its reply");
    }
    db.transaction((tx) => {
      tx.insert(conversationTurn)
        .values({ conversationId: id, turn, learnerText, createdAt: now() })
        .run();
      tx.update(conversation)
        .set({ turnCount: turn, updatedAt: now() })
        .where(eq(conversation.id, id))
        .run();
    });
    return turn;
  }

  /** The session's seed: the brief, and the opening and every answered turn. */
  function seedOf(c: ConversationRow): SessionSeed {
    const transcript: TranscriptLine[] = [{ speaker: "character", text: c.opening.line }];
    for (const t of turnsOf(c.id)) {
      if (t.line === null) continue;
      transcript.push(
        { speaker: "learner", text: t.learnerText },
        { speaker: "character", text: t.line },
      );
    }
    return {
      brief: buildCharacterBrief({
        character: c.characterLine,
        scene: c.scene,
        steps: c.steps.map(({ id, text }) => ({ id, text })),
        roleFacts: c.roleFacts,
        profile: profile(),
        memory: [],
        dueLemmas: c.dueLemmas,
      }),
      stepIds: c.steps.map((s) => s.id),
      transcript,
    };
  }

  function sessionOf(c: ConversationRow): ConversationSession {
    let session = sessions.get(c.id);
    if (!session) {
      session = deps.createSession(c.id);
      session.warm(seedOf(c));
      sessions.set(c.id, session);
    }
    return session;
  }

  /** Spawn the Conversation's session on screen open, so its startup overlaps the opening. */
  function open(id: number): void {
    sessionOf(get(id));
  }

  /** Ask the session to answer the learner's last turn. A failed reply can be asked again. */
  async function reply(id: number) {
    const c = get(id);
    const t = turnsOf(id).at(-1);
    if (!t || t.line !== null) throw new Error("no turn is waiting for a reply");
    db.update(conversationTurn)
      .set({ attempts: t.attempts + 1 })
      .where(eq(conversationTurn.id, t.id))
      .run();
    const result = await sessionOf(c).send(t.learnerText);
    const ticked = new Set(result.stepsTicked);
    const steps = get(id).steps.map((s) =>
      s.tickedTurn === null && ticked.has(s.id) ? { ...s, tickedTurn: t.turn } : s,
    );
    db.transaction((tx) => {
      tx.update(conversationTurn)
        .set({
          line: result.line,
          italian: result.italian,
          understood: result.understood,
          stepsTicked: result.stepsTicked,
          hint: result.hint,
          modelLine: result.modelLine,
        })
        .where(eq(conversationTurn.id, t.id))
        .run();
      tx.update(conversation).set({ steps, updatedAt: now() }).where(eq(conversation.id, id)).run();
    });
    return { turn: t.turn, line: result.line, italian: result.italian, steps: view(get(id)).steps };
  }

  /** Mark the character line of `turn` revealed; turn 0 is the opening. Grades nothing. */
  function reveal(id: number, turn: number): void {
    if (turn === 0) {
      db.update(conversation).set({ openingRevealed: true }).where(eq(conversation.id, id)).run();
      return;
    }
    db.update(conversationTurn)
      .set({ lineRevealed: true })
      .where(
        and(
          eq(conversationTurn.conversationId, id),
          eq(conversationTurn.turn, turn),
          isNotNull(conversationTurn.line),
        ),
      )
      .run();
  }

  /** Character lines the learner followed by ear, without revealing them (CONTEXT.md "Heard line"). */
  function heardLines(id: number): number {
    const c = get(id);
    const lines = turnsOf(id).filter((t) => t.line !== null && !t.lineRevealed).length;
    return lines + (c.openingRevealed ? 0 : 1);
  }

  /**
   * The words of the character line of `turn` (0 is the opening), for the word panel. The line is
   * not stored as a text, so its tokens have no id; its lemmas get no knowledge row until graded.
   */
  async function words(id: number, turn: number): Promise<PanelToken[]> {
    const line = turn === 0 ? get(id).opening.line : turnsOf(id).find((t) => t.turn === turn)?.line;
    if (!line) throw new Error(`turn ${turn} has no character line`);
    const analysis = await deps.analyze(line);
    const tokens = analysis.sentences.flatMap((s, sentenceIndex) =>
      s.tokens.map((tok) => {
        const saved = tokenLemma(db, tok, undefined);
        return {
          surface: tok.surface,
          isSpace: tok.is_space,
          sentenceIndex,
          tags: tok.tags,
          lemma: saved?.lemma ?? null,
          pos: saved?.pos ?? null,
          lemmaId: saved ? upsertLemma(db, saved.lemma, saved.pos) : null,
        };
      }),
    );
    const ids = tokens.flatMap((t) => (t.lemmaId === null ? [] : [t.lemmaId]));
    const rows = db
      .select({ id: lemma.id, flaggedAt: lemma.flaggedAt, state: knowledge.state })
      .from(lemma)
      .leftJoin(knowledge, and(eq(knowledge.lemmaId, lemma.id), eq(knowledge.track, "receptive")))
      .where(inArray(lemma.id, ids))
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return tokens.map((t, position) => {
      const row = t.lemmaId === null ? undefined : byId.get(t.lemmaId);
      return {
        ...t,
        id: null,
        position,
        flagged: row?.flaggedAt != null,
        ...knowledgeFlags(row?.state),
      };
    });
  }

  return { prepareScene, current, reroll, open, addTurn, reply, reveal, heardLines, words };
}
