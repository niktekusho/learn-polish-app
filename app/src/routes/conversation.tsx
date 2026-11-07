import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  CircleAlert,
  Eye,
  Lightbulb,
  RefreshCw,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { playVoice } from "#/audio/speak";
import { PushToTalk } from "#/audio/recorder";
import type { ConversationView, Ending, HelpOffer } from "#/conversation/service";
import type { HelpLevel } from "#/db/schema";
import { NamePanel, WordPanel } from "#/reader/WordPanel";
import { isName, nameForm } from "#/reader/name";
import type { PanelToken } from "#/reader/types";
import { plural } from "#/plural";
import {
  BTN_PRIMARY,
  BTN_QUIET,
  ERROR_LINE,
  ICON_BUTTON,
  LABEL,
  LABEL_TYPE,
  RETRY,
  TRACK,
  WORD,
} from "#/ui";

// The Conversation after the last Episode read. A scene the background run failed to
// prepare is prepared here, behind the pending screen.
const getConversationFn = createServerFn().handler(async () => {
  const { appConversationService } = await import("#/conversation/server");
  return appConversationService().current();
});

const idInput = (d: unknown) => z.object({ id: z.number().int() }).parse(d);

const openFn = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(async ({ data }) => {
    const { appConversationService } = await import("#/conversation/server");
    appConversationService().open(data.id);
  });

const rerollFn = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(async ({ data }) => {
    const { appConversationService } = await import("#/conversation/server");
    return appConversationService().reroll(data.id);
  });

// The learner's audio is transcribed and stored as a turn before any reply is asked.
const addTurnFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    if (!(d instanceof FormData)) throw new Error("expected FormData");
    const audio = d.get("audio");
    if (!(audio instanceof Blob)) throw new Error("missing audio");
    return { id: z.coerce.number().int().parse(d.get("id")), audio };
  })
  .handler(async ({ data }) => {
    const { transcribe } = await import("#/import/sidecar");
    const { appConversationService } = await import("#/conversation/server");
    const text = (await transcribe(data.audio)).trim();
    if (!text) return { text: null };
    appConversationService().addTurn(data.id, text);
    return { text };
  });

const lineInput = (d: unknown) =>
  z.object({ id: z.number().int(), turn: z.number().int().min(0) }).parse(d);

// Stored per line: a line never revealed is a Heard line. Grades nothing.
const revealFn = createServerFn({ method: "POST" })
  .validator(lineInput)
  .handler(async ({ data }) => {
    const { appConversationService } = await import("#/conversation/server");
    appConversationService().reveal(data.id, data.turn);
  });

// The Hint pair arrives with the line, so climbing the ladder only stores the reveal.
const revealHelpFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        id: z.number().int(),
        turn: z.number().int().min(0),
        level: z.enum(["hint", "modelLine"] satisfies HelpLevel[]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { appConversationService } = await import("#/conversation/server");
    appConversationService().revealHelp(data.id, data.turn, data.level);
  });

const wordsFn = createServerFn({ method: "POST" })
  .validator(lineInput)
  .handler(async ({ data }) => {
    const { appConversationService } = await import("#/conversation/server");
    return appConversationService().words(data.id, data.turn);
  });

const replyFn = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(async ({ data }) => {
    const { appConversationService } = await import("#/conversation/server");
    return appConversationService().reply(data.id);
  });

// Ends the scene at any turn: the Debrief call runs here, behind a wait.
const debriefFn = createServerFn({ method: "POST" })
  .validator(idInput)
  .handler(async ({ data }) => {
    const { appConversationService } = await import("#/conversation/server");
    return appConversationService().debrief(data.id);
  });

export const Route = createFileRoute("/conversation")({
  component: ConversationPage,
  loader: () => getConversationFn(),
  pendingComponent: () => <Wait>Preparo la scena…</Wait>,
});

const PAGE = "flex h-dvh flex-col bg-paper font-sans text-base text-ink";
// A reply slower than this shows the character thinking.
const THINKING_MS = 3000;

function TopBar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="flex shrink-0 items-center gap-1 px-1 py-1.5">
      <Link to="/" aria-label="Home" className={ICON_BUTTON}>
        <ArrowLeft size={20} />
      </Link>
      {children}
    </header>
  );
}

function Wait({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${PAGE} items-center justify-center gap-4 p-6 text-center`}>
      <div className="flex gap-2" aria-hidden>
        {[0, 150, 300].map((d) => (
          <i
            key={d}
            className="size-2.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none"
            style={{ animationDelay: `${d}ms` }}
          />
        ))}
      </div>
      <p role="status" className="max-w-[26ch] font-serif text-prose leading-normal text-ink-2">
        {children}
      </p>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={PAGE}>
      <TopBar />
      <main className="mx-auto grid w-full max-w-[34rem] content-start gap-3 px-4 pt-6">
        <h1 className="font-serif text-2xl leading-[1.2] font-bold">{title}</h1>
        {children}
      </main>
    </div>
  );
}

function ConversationPage() {
  const current = Route.useLoaderData();
  if (current.needsProfile) {
    return (
      <Notice title="Prima, il tuo profilo">
        <p className="font-serif text-[16px] leading-normal text-ink-2">
          Nella conversazione interpreti te stesso: scrivi qualcosa su di te.
        </p>
        <Link
          to="/profile"
          search={{ next: "conversation" }}
          className={`${BTN_PRIMARY} justify-self-start`}
        >
          Scrivi il tuo profilo
        </Link>
      </Notice>
    );
  }
  if (!current.conversation) {
    return (
      <Notice title="Nessuna conversazione">
        <p className="font-serif text-[16px] leading-normal text-ink-2">
          La conversazione segue l'ultimo episodio letto.
        </p>
        <Link to="/story" className={`${BTN_QUIET} justify-self-start`}>
          Vai alla storia
        </Link>
      </Notice>
    );
  }
  // A reroll replaces the setting, Goal and opening: a new key starts the screen afresh.
  const c = current.conversation;
  if (c.status === "debriefed") return <DebriefView conversation={c} />;
  const key = JSON.stringify([c.id, c.scene, c.steps.map((s) => s.text), c.opening.line]);
  return <ConversationScreen key={key} initial={c} />;
}

type Line =
  | { who: "learner"; text: string }
  | ({
      who: "character";
      text: string;
      italian: string;
      turn: number;
      revealed: boolean;
    } & HelpOffer);
type CharacterLineData = Extract<Line, { who: "character" }>;
type Phase =
  | "idle"
  | "transcribing"
  | "waiting"
  | "failed"
  | "unheard"
  | "rerolling"
  | "debriefing";

function linesOf(c: ConversationView): Line[] {
  const { line, ...opening } = c.opening;
  const lines: Line[] = [{ who: "character", text: line, turn: 0, ...opening }];
  c.turns.forEach((t, i) => {
    lines.push({ who: "learner", text: t.learnerText });
    if (t.line !== null) {
      const { learnerText: _, line, italian, ...rest } = t;
      lines.push({ who: "character", text: line, italian: italian ?? "", turn: i + 1, ...rest });
    }
  });
  return lines;
}

function ConversationScreen({ initial }: { initial: ConversationView }) {
  const router = useRouter();
  const c = initial;
  const [lines, setLines] = useState(() => linesOf(c));
  const [steps, setSteps] = useState(c.steps);
  const [ending, setEnding] = useState<Ending>(c);
  const [debriefFailed, setDebriefFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>(() =>
    c.turns.at(-1)?.line === null ? "failed" : "idle",
  );
  const [thinking, setThinking] = useState(false);
  const [selected, setSelected] = useState<{ token: PanelToken; sentence: string } | null>(null);
  const thinkingTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const play = (text: string) => c.voice && playVoice(text, c.voice).catch(() => {});

  useEffect(() => {
    void openFn({ data: { id: c.id } });
    if (c.turns.length === 0) play(c.opening.line);
    return () => clearTimeout(thinkingTimer.current);
  }, []);

  async function ask() {
    setPhase("waiting");
    thinkingTimer.current = setTimeout(() => setThinking(true), THINKING_MS);
    try {
      const r = await replyFn({ data: { id: c.id } });
      const { line, italian, turn, hint, modelLine } = r;
      setLines((ls) => [
        ...ls,
        {
          who: "character",
          text: line,
          italian,
          turn,
          revealed: false,
          hint,
          modelLine,
          help: null,
        },
      ]);
      setSteps(r.steps);
      setEnding(r);
      setPhase("idle");
      play(r.line);
    } catch {
      setPhase("failed");
    } finally {
      clearTimeout(thinkingTimer.current);
      setThinking(false);
    }
  }

  async function sendAudio(blob: Blob) {
    setPhase("transcribing");
    const form = new FormData();
    form.append("id", String(c.id));
    form.append("audio", blob);
    try {
      const { text } = await addTurnFn({ data: form });
      if (!text) {
        setPhase("unheard");
        return;
      }
      setLines((ls) => [...ls, { who: "learner", text }]);
      await ask();
    } catch {
      setPhase("unheard");
    }
  }

  async function reroll() {
    setPhase("rerolling");
    try {
      await rerollFn({ data: { id: c.id } });
      await router.invalidate();
    } finally {
      // A reroll that wrote the same scene keeps the key, so this screen stays mounted.
      setPhase("idle");
    }
  }

  async function debrief() {
    const before = phase;
    setPhase("debriefing");
    setDebriefFailed(false);
    try {
      await debriefFn({ data: { id: c.id } });
      await router.invalidate();
    } catch {
      setDebriefFailed(true);
      setPhase(before);
    }
  }

  if (phase === "rerolling") return <Wait>Preparo un'altra scena…</Wait>;
  if (phase === "debriefing") return <Wait>Preparo le correzioni…</Wait>;
  const last = lines.at(-1)!;

  return (
    <div className={`${PAGE} relative`}>
      <header className="shrink-0 border-b border-rule bg-card pr-4 pb-3">
        <TopBar>
          <span className={LABEL}>{c.character}</span>
          <button
            type="button"
            onClick={debrief}
            disabled={phase === "transcribing"}
            className={`ml-auto inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-sm font-semibold transition-colors duration-300 disabled:opacity-45 ${
              ending.highlightDebrief ? "bg-accent text-white shadow-button" : "text-accent-ink"
            }`}
          >
            Com'è andata
            <ChevronRight size={16} />
          </button>
        </TopBar>
        <div className="grid gap-2 pl-4">
          <p className="font-serif text-base leading-snug text-ink-2">{c.scene}</p>
          {c.roleFacts && (
            <p className="font-serif text-base leading-snug text-ink-2">
              <span className={`${LABEL_TYPE} mr-2 text-ink-3`}>Il tuo ruolo</span>
              {c.roleFacts}
            </p>
          )}
          <GoalSteps steps={steps} />
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col-reverse overflow-auto px-4 py-4">
        <div className="mx-auto flex w-full max-w-[40rem] flex-col gap-3" aria-live="polite">
          {lines.map((l, i) =>
            l.who === "character" ? (
              <CharacterLine
                key={i}
                conversationId={c.id}
                line={l}
                onPlay={() => play(l.text)}
                onWord={(token, sentence) => setSelected({ token, sentence })}
              />
            ) : (
              <p
                key={i}
                lang="pl"
                className="max-w-[85%] self-end rounded-2xl rounded-br-sm bg-accent-soft px-4 py-3 font-serif text-md text-accent-ink"
              >
                {l.text}
              </p>
            ),
          )}
          {phase === "waiting" && thinking && (
            <p role="status" className="self-start px-2 text-sm text-ink-3 italic">
              {c.character} sta pensando…
            </p>
          )}
        </div>
      </main>

      <div className="grid shrink-0 justify-items-center gap-3 border-t border-rule bg-paper/85 px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))]">
        {debriefFailed && (
          <p role="alert" className={`${ERROR_LINE} justify-center`}>
            <CircleAlert size={18} />
            Correzioni non pronte.
            <button type="button" onClick={debrief} className={RETRY}>
              Riprova
            </button>
          </p>
        )}
        {!ending.sceneClosed &&
          last.who === "character" &&
          (phase === "idle" || phase === "unheard") && (
            <HelpLadder key={last.turn} conversationId={c.id} line={last} />
          )}
        {phase === "transcribing" && (
          <p role="status" className="text-sm text-ink-2">
            Trascrivo…
          </p>
        )}
        {phase === "unheard" && (
          <p role="alert" className={`${ERROR_LINE} justify-center`}>
            <CircleAlert size={18} />
            Non ho sentito. Tieni premuto e riprova.
          </p>
        )}
        {phase === "failed" ? (
          <p role="alert" className={`${ERROR_LINE} justify-center`}>
            <CircleAlert size={18} />
            Non risponde.
            <button type="button" onClick={ask} className={RETRY}>
              Riprova
            </button>
          </p>
        ) : ending.sceneClosed ? (
          <button type="button" onClick={debrief} className={BTN_PRIMARY}>
            Com'è andata
            <ChevronRight size={18} />
          </button>
        ) : (
          <PushToTalk
            onRecorded={sendAudio}
            color={TRACK.productive.color}
            disabled={phase === "transcribing" || phase === "waiting"}
          />
        )}
        {lines.length === 1 && phase === "idle" && (
          <button type="button" onClick={reroll} className={BTN_QUIET}>
            <RefreshCw size={18} />
            Un'altra scena
          </button>
        )}
      </div>

      {selected && (
        <aside className="contents sm:absolute sm:inset-y-0 sm:right-0 sm:z-10 sm:flex sm:w-[min(42%,380px)] sm:flex-col sm:border-l sm:border-rule sm:bg-panel">
          {isName(selected.token.pos) ? (
            <NamePanel token={selected.token} onClose={() => setSelected(null)} />
          ) : (
            <WordPanel
              key={`${selected.token.lemmaId}-${selected.sentence}`}
              token={selected.token}
              sentence={selected.sentence}
              onClose={() => setSelected(null)}
            />
          )}
        </aside>
      )}
    </div>
  );
}

/**
 * A character line plays with its text hidden, to train the ear. The first tap reveals the
 * Polish, whose words open the word panel; the second tap reveals the Italian.
 */
function CharacterLine({
  conversationId,
  line,
  onPlay,
  onWord,
}: {
  conversationId: number;
  line: CharacterLineData;
  onPlay: () => void;
  onWord: (token: PanelToken, sentence: string) => void;
}) {
  const [shown, setShown] = useState<"none" | "polish" | "italian">(
    line.revealed ? "polish" : "none",
  );
  const [words, setWords] = useState<PanelToken[] | null>(null);
  const data = { id: conversationId, turn: line.turn };

  useEffect(() => {
    if (shown === "none" || words) return;
    // Without its words the line still reads as plain text.
    wordsFn({ data })
      .then(setWords)
      .catch(() => {});
  }, [shown]);

  function revealPolish() {
    setShown("polish");
    revealFn({ data }).catch((err) => console.error("[conversation] reveal not stored:", err));
  }

  const sentenceOf = (t: PanelToken) =>
    words!
      .filter((w) => w.sentenceIndex === t.sentenceIndex)
      .map((w) => w.surface)
      .join("")
      .trim();

  return (
    <div className="flex max-w-[85%] items-start gap-1 self-start rounded-2xl rounded-bl-sm border border-rule bg-card py-1 pr-4 pl-1">
      <button type="button" onClick={onPlay} aria-label="Ascolta" className={ICON_BUTTON}>
        <Volume2 size={18} className="text-accent" />
      </button>
      {shown === "none" ? (
        <button
          type="button"
          onClick={revealPolish}
          className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-3 italic"
        >
          <Eye size={16} />
          Tocca per leggere
        </button>
      ) : (
        <span className="grid gap-1 py-2">
          <span lang="pl" className="font-serif text-md">
            {words
              ? words.map((t, i) =>
                  t.lemmaId === null ||
                  (isName(t.pos) && !nameForm(t.surface, t.lemma ?? "", t.tags)) ? (
                    <span key={i}>{t.surface}</span>
                  ) : (
                    <span
                      key={i}
                      onClick={() => onWord(t, sentenceOf(t))}
                      className={`${WORD}${isName(t.pos) ? " text-word-name" : ""}`}
                    >
                      {t.surface}
                    </span>
                  ),
                )
              : line.text}
          </span>
          {shown === "italian" ? (
            <span lang="it" className="text-sm text-ink-3 italic">
              {line.italian}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setShown("italian")}
              className="min-h-11 justify-self-start text-sm text-ink-3 italic underline decoration-dotted underline-offset-4"
            >
              Mostra l'italiano
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * The Help ladder for the learner's next turn: the first tap shows the Hint words, the second
 * the Model line. A line whose Hint words all failed the dictionary check goes to the Model line.
 */
function HelpLadder({ conversationId, line }: { conversationId: number; line: CharacterLineData }) {
  const [help, setHelp] = useState(line.help);

  function climb() {
    const level = help === null && line.hint.length > 0 ? "hint" : "modelLine";
    setHelp(level);
    revealHelpFn({ data: { id: conversationId, turn: line.turn, level } }).catch((err) =>
      console.error("[conversation] help reveal not stored:", err),
    );
  }

  return (
    <div className="grid w-full max-w-[34rem] justify-items-center gap-2">
      {help !== null && line.hint.length > 0 && (
        <ul lang="pl" aria-label="Parole utili" className="flex flex-wrap justify-center gap-2">
          {line.hint.map((w) => (
            <li
              key={w}
              className="rounded-full bg-accent-soft px-3 py-1 font-serif text-base text-accent-ink"
            >
              {w}
            </li>
          ))}
        </ul>
      )}
      {help === "modelLine" && (
        <p lang="pl" className="text-center font-serif text-md">
          {line.modelLine}
        </p>
      )}
      {help !== "modelLine" && (
        <button type="button" onClick={climb} className={BTN_QUIET}>
          <Lightbulb size={18} />
          {help === null ? "Aiuto" : "Frase da leggere"}
        </button>
      )}
    </div>
  );
}

function GoalSteps({ steps }: { steps: ConversationView["steps"] }) {
  return (
    <div>
      <h2 className={`${LABEL_TYPE} text-ink-3`}>Obiettivo</h2>
      <ul className="mt-1 grid gap-1">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 font-serif text-base leading-snug">
            <span
              className={`mt-0.5 inline-grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-300 ${
                s.ticked ? "bg-good text-white" : "border-[1.5px] border-rule"
              }`}
            >
              {s.ticked && <Check size={13} strokeWidth={3} />}
            </span>
            <span className={s.ticked ? "text-ink-3" : "text-ink"}>
              {s.text}
              <span className="sr-only">{s.ticked ? " (fatto)" : ""}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Debrief: the Goal as it ended and the corrections, recurring patterns first. */
function DebriefView({ conversation: c }: { conversation: ConversationView }) {
  const corrections = c.corrections ?? [];
  const turns = c.turns.length;
  return (
    <div className={PAGE}>
      <TopBar />
      <main className="mx-auto grid min-h-0 w-full max-w-[34rem] flex-1 content-start gap-5 overflow-auto px-4 pt-4 pb-8">
        <div className="grid gap-1">
          <span className={LABEL}>
            {c.character} · {turns} {plural(turns, "turno", "turni")}
          </span>
          <h1 className="font-serif text-2xl leading-[1.2] font-bold">Com'è andata</h1>
        </div>
        <GoalSteps steps={c.steps} />
        <section className="grid gap-3">
          <h2 className={`${LABEL_TYPE} text-ink-3`}>Correzioni</h2>
          {corrections.length === 0 ? (
            <p className="font-serif text-base text-ink-2">Nessuna correzione.</p>
          ) : (
            <ol className="grid gap-3">
              {corrections.map((correction, i) => (
                <li key={i} className="rounded border border-rule bg-card p-4">
                  <p lang="pl" className="font-serif text-md">
                    <s className="text-bad-ink">{correction.said}</s> →{" "}
                    <b>{correction.corrected}</b>
                  </p>
                  <p lang="it" className="mt-1 text-sm text-ink-2">
                    {correction.italian}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </section>
        <Link to="/story" className={`${BTN_QUIET} justify-self-start`}>
          Torna alla storia
        </Link>
      </main>
    </div>
  );
}
