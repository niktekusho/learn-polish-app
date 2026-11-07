import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import {
  characterMemory,
  characterVoice,
  conversation,
  conversationTurn,
  type DebriefCorrection,
  HELP_LEVELS,
  type HelpLevel,
  knowledge,
  lemma,
  sourceText,
} from "#/db/schema";
import { dictionaryWords } from "#/dictionary/service";
import { dueLemmas } from "#/fsrs/index";
import { gradeTurn, metLemmas, type TurnEvidence } from "./grading";
import { tokenLemma, upsertLemma } from "#/import/pipeline";
import type { AnalyzeResponse, Voice } from "#/import/sidecar";
import { buildCharacterBrief } from "#/llm/conversation-brief";
import type {
  ConversationSession,
  SessionSeed,
  TranscriptLine,
  TurnResult,
} from "#/llm/conversation-session";
import { MAX_CORRECTIONS, type SceneProvider, type SceneRequest } from "#/llm/provider";
import { getLearnerProfile, type LearnerProfile } from "#/profile/service";
import { knowledgeFlags } from "#/reader/knowledge";
import { conversationEpisode, recordActivity } from "#/recap/service";
import { heardLineCount } from "./heard-lines";
import type { PanelToken } from "#/reader/types";
import { storyCharacters } from "#/story/character-names";

type DB = BetterSQLite3Database<typeof schema>;
type ConversationRow = typeof conversation.$inferSelect;
type TurnRow = typeof conversationTurn.$inferSelect;

// Due Productive lemmas the scene is nudged toward: a few, so the Goal stays natural.
const DUE_LEMMAS = 5;
// A scene this long gets the Debrief button highlighted; at LAST_TURN the character closes it.
const NUDGE_TURN = 15;
const LAST_TURN = 25;
// Learner turns a debriefed Conversation needs to count for the daily routine.
const DAILY_TURNS = 3;

export interface ConversationDeps {
  provider: SceneProvider;
  voices: () => Promise<Voice[]>; // the sidecar's Piper catalog
  analyze: (text: string) => Promise<AnalyzeResponse>;
  createSession: (conversationId: number) => ConversationSession;
  now?: () => Date;
}

/** How far the scene is from its end, as the Debrief button and the mic show it. */
export interface Ending {
  highlightDebrief: boolean; // every Goal step ticked, or turn 15 reached
  sceneClosed: boolean; // the hard stop: no further learner turn
}

export interface ConversationView extends Ending {
  id: number;
  status: ConversationRow["status"];
  corrections: DebriefCorrection[] | null; // the Debrief, once debriefed
  character: string;
  voice: string;
  scene: string;
  roleFacts: string | null;
  steps: { id: string; text: string; ticked: boolean }[];
  opening: { line: string; italian: string; revealed: boolean } & HelpOffer;
  turns: ({
    learnerText: string;
    line: string | null;
    italian: string | null;
    revealed: boolean;
  } & HelpOffer)[];
}

/** The Help ladder offered after a character line: Hint words, then a Model line. */
export interface HelpOffer {
  hint: string[];
  modelLine: string;
  help: HelpLevel | null; // the highest rung revealed
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

  /** Character memory lines per character name, for the Story's characters that have any. */
  function memoriesOf(storyId: number): Map<string, string[]> {
    const rows = db
      .select()
      .from(characterMemory)
      .where(eq(characterMemory.storyId, storyId))
      .all();
    return new Map(rows.map((r) => [r.character, r.lines]));
  }

  const memoryOf = (c: ConversationRow) => memoriesOf(c.storyId).get(c.character) ?? [];

  /** One scene call for `episodeId`, and the row values it gives. */
  async function askScene(episodeId: number, profile: LearnerProfile) {
    const episode = db.select().from(sourceText).where(eq(sourceText.id, episodeId)).get();
    if (!episode?.storyId) throw new Error(`text ${episodeId} is not an episode`);
    const storyId = episode.storyId;
    const characters = storyCharacters(db, storyId);
    // A Story gets its voices on its first Conversation and keeps them.
    const voices = voicesOf(storyId).size === 0 ? await deps.voices() : null;
    const memories = memoriesOf(storyId);
    const req: SceneRequest = {
      episode: episode.content,
      characters: characters.map((c) => c.description),
      profile,
      dueLemmas: dueLemmas(db, "productive", { now: now(), limit: DUE_LEMMAS }).map((l) => l.lemma),
      voices: voices && voices.map(({ id, label }) => ({ id, label })),
      memory: characters.map((c) => memories.get(c.name) ?? []),
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
        opening: { ...scene.opening, hint: dictionaryWords(db, scene.opening.hint) },
        openingRevealed: false,
        openingHelp: null,
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

  function ending(c: ConversationRow): Ending {
    return {
      highlightDebrief: c.turnCount >= NUDGE_TURN || c.steps.every((s) => s.tickedTurn !== null),
      sceneClosed: c.turnCount >= LAST_TURN,
    };
  }

  function view(c: ConversationRow): ConversationView {
    const turns = turnsOf(c.id);
    return {
      id: c.id,
      status: c.status,
      corrections: c.corrections,
      ...ending(c),
      character: c.character,
      voice: voicesOf(c.storyId).get(c.character) ?? "",
      scene: c.scene,
      roleFacts: c.roleFacts,
      steps: c.steps.map((s) => ({ id: s.id, text: s.text, ticked: s.tickedTurn !== null })),
      opening: {
        line: c.opening.line,
        italian: c.opening.italian,
        revealed: c.openingRevealed,
        hint: c.opening.hint,
        modelLine: c.opening.modelLine,
        help: c.openingHelp,
      },
      turns: turns.map((t) => ({
        learnerText: t.learnerText,
        line: t.line,
        italian: t.italian,
        revealed: t.lineRevealed,
        hint: t.hint ?? [],
        modelLine: t.modelLine ?? "",
        help: t.help,
      })),
    };
  }

  /**
   * The current Conversation (see `conversationEpisode`). Missing (the background preparation
   * failed or is still running): wait for it or prepare it now.
   */
  async function current(): Promise<CurrentConversation> {
    if (!getLearnerProfile(db)) return { needsProfile: true };
    const episodeId = conversationEpisode(db);
    if (episodeId === null) return { needsProfile: false, conversation: null };
    await running.get(episodeId)?.catch(() => {});
    await prepareScene(episodeId);
    const c = byEpisode(episodeId);
    return { needsProfile: false, conversation: c ? view(c) : null };
  }

  /** A new Goal, role facts, opening and first Hint pair, before the learner's first turn. */
  async function reroll(id: number): Promise<ConversationView> {
    const c = get(id);
    if (c.status !== "open") throw new Error("the Conversation is debriefed");
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
    const c = get(id);
    if (c.status !== "open" || ending(c).sceneClosed) throw new Error("the scene is closed");
    const turn = c.turnCount + 1;
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

  /** The opening and every learner turn with its reply; only the last turn can lack one. */
  function transcriptOf(c: ConversationRow): TranscriptLine[] {
    const transcript: TranscriptLine[] = [{ speaker: "character", text: c.opening.line }];
    for (const t of turnsOf(c.id)) {
      transcript.push({ speaker: "learner", text: t.learnerText });
      if (t.line !== null) transcript.push({ speaker: "character", text: t.line });
    }
    return transcript;
  }

  /** The session's seed: the brief, and the transcript without a turn still waiting for its reply. */
  function seedOf(c: ConversationRow): SessionSeed {
    const transcript = transcriptOf(c);
    if (transcript.at(-1)?.speaker === "learner") transcript.pop();
    return {
      brief: buildCharacterBrief({
        character: c.characterLine,
        scene: c.scene,
        steps: c.steps.map(({ id, text }) => ({ id, text })),
        roleFacts: c.roleFacts,
        profile: profile(),
        memory: memoryOf(c),
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

  /** What grading needs about the learner's last turn, which is still waiting for its reply. */
  async function evidenceOf(c: ConversationRow, learnerText: string): Promise<TurnEvidence> {
    const answered = turnsOf(c.id).filter((r) => r.line !== null);
    const lines = [c.opening.line, ...answered.map((r) => r.line as string)];
    // The Help ladder on this turn is the one offered with the line before it.
    const before = answered.at(-1);
    const help = before ? before.help : c.openingHelp;
    const hint = before ? (before.hint ?? []) : c.opening.hint;
    const [said, echoes, hinted] = await Promise.all([
      metLemmas(db, deps.analyze, learnerText),
      metLemmas(db, deps.analyze, lines.slice(-2).join(" ")),
      help ? metLemmas(db, deps.analyze, hint.join(" ")) : new Set<number>(),
    ]);
    return { said, echoes, hinted, help };
  }

  /**
   * Send turn `t` to the character. The first failure at a turn is retried at once, so a hiccup
   * is invisible; after that each call is one attempt, as the learner presses Riprova.
   */
  async function ask(t: TurnRow): Promise<TurnResult> {
    const tries = t.attempts === 0 ? 2 : 1;
    for (let i = 1; ; i++) {
      const attempt = t.attempts + i;
      db.update(conversationTurn)
        .set({ attempts: attempt })
        .where(eq(conversationTurn.id, t.id))
        .run();
      try {
        return await sessionOf(get(t.conversationId)).send(t.learnerText, {
          lastTurn: t.turn === LAST_TURN,
          attempt,
        });
      } catch (err) {
        // The next attempt gets a freshly spawned session, reseeded from the stored transcript.
        sessions.get(t.conversationId)?.close();
        sessions.delete(t.conversationId);
        if (i === tries || get(t.conversationId).status !== "open") throw err;
      }
    }
  }

  /**
   * Ask the session to answer the learner's last turn, and grade the turn if the character
   * understood it. A failed reply grades nothing and can be asked again.
   */
  async function reply(id: number) {
    const c = get(id);
    if (c.status !== "open") throw new Error("the Conversation is debriefed");
    const t = turnsOf(id).at(-1);
    if (!t || t.line !== null) throw new Error("no turn is waiting for a reply");
    // Analysis runs alongside the session, so grading adds no wait. A failed analysis grades
    // nothing: failing the reply would make the retry send the turn to the character again.
    const evidence = evidenceOf(c, t.learnerText).catch((e: unknown) => {
      console.error(`conversation ${id} turn ${t.turn} not graded:`, e);
      return null;
    });
    const result = await ask(t);
    const analyzed = await evidence;
    // A Debrief tapped while the reply was on its way ended the scene at this turn.
    if (get(id).status !== "open") throw new Error("the Conversation is debriefed");
    if (analyzed && result.understood) gradeTurn(db, analyzed, now());
    const hint = dictionaryWords(db, result.hint);
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
          hint,
          modelLine: result.modelLine,
        })
        .where(eq(conversationTurn.id, t.id))
        .run();
      tx.update(conversation).set({ steps, updatedAt: now() }).where(eq(conversation.id, id)).run();
    });
    return {
      turn: t.turn,
      line: result.line,
      italian: result.italian,
      hint,
      modelLine: result.modelLine,
      steps: view(get(id)).steps,
      ...ending(get(id)),
    };
  }

  /**
   * End the scene with the Debrief, at any turn. Without a learner turn there is nothing to
   * correct, so no call is made. A failed call leaves the scene open to try again.
   */
  async function debrief(id: number): Promise<ConversationView> {
    const c = get(id);
    if (c.status === "debriefed") return view(c);
    const memory = memoryOf(c);
    const result =
      c.turnCount === 0
        ? { corrections: [], memory: [] }
        : await deps.provider.debrief(
            { transcript: transcriptOf(c), character: c.characterLine, memory },
            id,
          );
    db.transaction((tx) => {
      tx.update(conversation)
        .set({
          status: "debriefed",
          corrections: result.corrections.slice(0, MAX_CORRECTIONS),
          updatedAt: now(),
        })
        .where(eq(conversation.id, id))
        .run();
      if (c.turnCount === 0) return;
      tx.insert(characterMemory)
        .values({
          storyId: c.storyId,
          character: c.character,
          lines: result.memory,
          updatedAt: now(),
        })
        .onConflictDoUpdate({
          target: [characterMemory.storyId, characterMemory.character],
          set: { lines: result.memory, updatedAt: now() },
        })
        .run();
    });
    if (c.turnCount >= DAILY_TURNS) recordActivity(db, "conversation", now());
    sessions.get(id)?.close();
    sessions.delete(id);
    return view(get(id));
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

  /**
   * Store how far up the Help ladder the learner climbed after the character line of `turn`
   * (0 is the opening). The pair arrives with that line, so no call is made. The session is
   * never told: the character must not know whether a Hint was used.
   */
  function revealHelp(id: number, turn: number, level: HelpLevel): void {
    const higher = (current: HelpLevel | null) =>
      current === null || HELP_LEVELS.indexOf(level) > HELP_LEVELS.indexOf(current);
    if (turn === 0) {
      if (!higher(get(id).openingHelp)) return;
      db.update(conversation).set({ openingHelp: level }).where(eq(conversation.id, id)).run();
      return;
    }
    const t = turnsOf(id).find((r) => r.turn === turn);
    if (!t || t.line === null) throw new Error(`turn ${turn} has no character line`);
    if (!higher(t.help)) return;
    db.update(conversationTurn).set({ help: level }).where(eq(conversationTurn.id, t.id)).run();
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

  return {
    prepareScene,
    current,
    reroll,
    open,
    addTurn,
    reply,
    debrief,
    reveal,
    revealHelp,
    heardLines: (id: number) => heardLineCount(db, id),
    words,
  };
}
