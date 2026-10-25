import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeft, Check, Flag, Mic, MicOff, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { PushToTalk } from "#/audio/recorder";
import { ListenButton } from "#/audio/speak";
import type { ClientPracticeItem } from "#/practice/session";
import { Corrections } from "#/report/Corrections";
import { wordPattern } from "#/reader/word-pattern";
import {
  BTN_BAD,
  BTN_GOOD,
  BTN_PRIMARY,
  BTN_QUIET,
  CHOICE,
  CHOICE_STATE,
  ICON_BUTTON,
  LABEL,
  LABEL_TYPE,
  Tick,
} from "#/ui";

// Build a new session, or resume the held one by id (reload/refocus). No LLM
// calls: buildSession only reads cached glosses. A new session takes the unseen
// corrections, so they show once.
const startSession = createServerFn()
  .validator((d: unknown) =>
    z.object({ sessionId: z.string().nullable(), mic: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { buildSession, resumeSession } = await import("#/practice/session");
    const { takeCorrections } = await import("#/report/review");
    if (data.sessionId) {
      const resumed = resumeSession(data.sessionId);
      if (resumed) return { ...resumed, corrections: [] };
    }
    return { ...buildSession(db, { mic: data.mic }), corrections: takeCorrections(db) };
  });

// Grade one MCQ answer against the server-held item (exactly once).
const submitAnswer = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        sessionId: z.string(),
        itemId: z.string(),
        choiceIndex: z.number().int().min(0),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { answerItem } = await import("#/practice/session");
    return answerItem(db, data.sessionId, data.itemId, data.choiceIndex);
  });

// Speaking answer: audio blob in, ASR verdict out. FormData because the
// payload is binary; grading stays server-side (#9).
const submitSpeech = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    if (!(d instanceof FormData)) throw new Error("expected FormData");
    const audio = d.get("audio");
    if (!(audio instanceof Blob)) throw new Error("missing audio");
    return {
      sessionId: String(d.get("sessionId") ?? ""),
      itemId: String(d.get("itemId") ?? ""),
      audio,
    };
  })
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { answerSpeechItem } = await import("#/practice/session");
    return answerSpeechItem(db, data.sessionId, data.itemId, data.audio);
  });

// Give-up / no-mic path: reveal the answer without grading.
const revealSpeech = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ sessionId: z.string(), itemId: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { revealItem } = await import("#/practice/session");
    return revealItem(data.sessionId, data.itemId);
  });

// After a reveal (ASR miss or give-up): the learner's own verdict does the
// FSRS write.
const submitSelfGrade = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ sessionId: z.string(), itemId: z.string(), saidIt: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { selfGradeItem } = await import("#/practice/session");
    return selfGradeItem(db, data.sessionId, data.itemId, data.saidIt);
  });

// "wrong": flag the lemma out of practice until its Report review.
// "context": mark it context-bound (no more single-word exercises).
const submitReport = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        sessionId: z.string(),
        itemId: z.string(),
        kind: z.enum(["wrong", "context"]),
        note: z.string().max(500),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { markContextBound, reportItem } = await import("#/practice/session");
    return data.kind === "context"
      ? markContextBound(db, data.sessionId, data.itemId)
      : reportItem(db, data.sessionId, data.itemId, data.note);
  });

// End-of-session note (slot line). Null while the session isn't finished.
const getSummary = createServerFn()
  .validator((d: unknown) => z.object({ sessionId: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { sessionSummary } = await import("#/practice/session");
    const summary = sessionSummary(db, data.sessionId);
    if (summary?.first) {
      const { relinkDerivedWords, repairLemmaSlips } = await import("#/maintenance/ops");
      const { getImportStatus } = await import("#/dictionary/import-job");
      const { getGlossProvider } = await import("#/llm/index");
      // A half-loaded dictionary makes real lemmas look like slips. The import repairs once it ends.
      if (getImportStatus().state !== "importing") {
        try {
          relinkDerivedWords(db);
          repairLemmaSlips(db);
          // After the sweep, so a reported slip is repaired and never reaches the LLM.
          const { reviewReports } = await import("#/report/review");
          reviewReports(db, getGlossProvider()).catch((err) =>
            console.error("[report-review] failed:", err),
          );
        } catch (err) {
          console.error("[slips] repair failed:", err);
        }
      }
      // Prepare passage questions for the coming days, off the request path.
      const { prepareUpcomingPassages } = await import("#/passage/service");
      const { analyze } = await import("#/import/sidecar");
      prepareUpcomingPassages(db, getGlossProvider(), analyze).catch((err) =>
        console.error("[passage] background prep failed:", err),
      );
    }
    return summary;
  });

export const Route = createFileRoute("/practice")({
  validateSearch: (s: Record<string, unknown>): { session?: string; mic?: boolean } => ({
    session: typeof s.session === "string" ? s.session : undefined,
    mic: typeof s.mic === "boolean" ? s.mic : undefined,
  }),
  loaderDeps: ({ search }) => ({
    session: search.session ?? null,
    mic: search.mic ?? true,
  }),
  loader: ({ deps }) => startSession({ data: { sessionId: deps.session, mic: deps.mic } }),
  component: Practice,
});

type SpeechPhase =
  | { itemId: string; phase: "busy" }
  | { itemId: string; phase: "correct"; answer: string; transcript: string; hint?: Hint }
  | {
      itemId: string;
      phase: "revealed";
      answer: string;
      alternatives?: string[];
      transcript: string;
      heard: boolean; // spoken recall: a retry after the reveal was heard
    };

type Hint = { lemma: string; difficulty: number; due: Date };
type Kind = ClientPracticeItem["kind"];

const TRACK = {
  receptive: {
    name: "Capire",
    dot: "bg-receptive",
    ink: "text-receptive-ink",
    color: "var(--color-receptive)",
  },
  productive: {
    name: "Ricordare",
    dot: "bg-productive",
    ink: "text-productive-ink",
    color: "var(--color-productive)",
  },
  pronunciation: {
    name: "Pronunciare",
    dot: "bg-pronunciation",
    ink: "text-pronunciation-ink",
    color: "var(--color-pronunciation)",
  },
};

// The hue an item carries: the track its first answer grades.
const EXERCISE: Record<Kind, { name: string; track: keyof typeof TRACK }> = {
  "recognition-mcq": { name: "Riconosci", track: "receptive" },
  passage: { name: "Brano", track: "receptive" },
  "spoken-recall": { name: "Dillo in polacco", track: "productive" },
  "read-aloud": { name: "Leggi ad alta voce", track: "pronunciation" },
};

function Practice() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();

  // Pin the session id in the URL so a reload resumes instead of rebuilding.
  useEffect(() => {
    if (search.session !== data.sessionId) {
      navigate({
        to: "/practice",
        search: { session: data.sessionId, mic: search.mic },
        replace: true,
      });
    }
  }, [data.sessionId, search.session, search.mic, navigate]);

  // key: a new session (e.g. after the mic toggle rebuilds it) must reset all
  // per-session state — answered map, reveal, speech phase.
  return <PracticeSession key={data.sessionId} />;
}

function PracticeSession() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const mic = search.mic ?? true;

  // Grows by one Retry per miss (appended by the server on the miss).
  const [items, setItems] = useState(data.items);
  const [answered, setAnswered] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(data.answered.map((a) => [a.itemId, a.correct])),
  );
  const [reveal, setReveal] = useState<{
    itemId: string;
    correctIndex: number;
    picked: number;
  } | null>(null);
  const [speech, setSpeech] = useState<SpeechPhase | null>(null);
  // Alternative answers already said, per spoken-recall item: named in the prompt.
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  // The URL pin reloads the data as a resume, which carries no corrections: keep the first ones.
  const [corrections] = useState(data.corrections);
  const [started, setStarted] = useState(corrections.length === 0);

  const micToggle = (
    <button
      type="button"
      onClick={() =>
        // Toggling rebuilds the session: the mix itself changes with the mic.
        navigate({ to: "/practice", search: { mic: !mic }, replace: true })
      }
      aria-label="Esercizi a voce"
      aria-pressed={mic}
      className={ICON_BUTTON}
    >
      {mic ? <Mic size={20} /> : <MicOff size={20} />}
    </button>
  );

  if (!started) {
    return (
      <Screen
        bar={<Bar done={0}>{micToggle}</Bar>}
        inline
        actions={
          <button type="button" onClick={() => setStarted(true)} className={BTN_PRIMARY}>
            Inizia
          </button>
        }
      >
        <h1 className="flex items-center gap-3 font-serif text-xl font-bold text-balance">
          Corretti <Count n={corrections.length} />
        </h1>
        <p className="text-ink-2">
          Dopo l'ultima sessione ho corretto queste parole. Annulla quello che non ti convince.
        </p>
        <Corrections items={corrections} />
      </Screen>
    );
  }

  if (items.length === 0) {
    return (
      <Screen bar={<Bar done={0}>{micToggle}</Bar>}>
        <End title="Niente da ripassare ora.">
          <p className="text-sm text-ink-3">Torna più tardi o leggi un episodio.</p>
        </End>
      </Screen>
    );
  }

  const total = items.length;
  const answeredCount = Object.keys(answered).length;
  const index = items.findIndex((it) => !(it.id in answered));

  if (index === -1) {
    const firsts = items.filter((it) => !it.retry);
    const correctCount = firsts.filter((it) => answered[it.id]).length;
    const perTrack = Object.entries(TRACK).map(([track, t]) => ({
      ...t,
      n: firsts.filter((it) => EXERCISE[it.kind].track === track).length,
    }));
    return (
      <Screen bar={<Bar done={1}>{micToggle}</Bar>}>
        <End title="Sessione completata">
          <p className="text-ink-2 tabular-nums">
            {firsts.length} {firsts.length === 1 ? "ripassata" : "ripassate"} · {correctCount}{" "}
            {correctCount === 1 ? "giusta" : "giuste"}
          </p>
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-sm font-semibold tabular-nums">
            {perTrack
              .filter((t) => t.n > 0)
              .map((t) => (
                <span key={t.name} className={`inline-flex items-center gap-2 ${t.ink}`}>
                  <i className={`size-2 rounded-full ${t.dot}`} />
                  {t.name} {t.n}
                </span>
              ))}
          </div>
          <SessionNote sessionId={data.sessionId} />
        </End>
      </Screen>
    );
  }

  const item = items[index];
  const track = TRACK[EXERCISE[item.kind].track];
  const nextLabel = index + 1 < total ? "Avanti" : "Fine";

  async function choose(choiceIndex: number) {
    if (reveal || busy || (item.kind !== "recognition-mcq" && item.kind !== "passage")) return;
    setBusy(true);
    try {
      const res = await submitAnswer({
        data: { sessionId: data.sessionId, itemId: item.id, choiceIndex },
      });
      setReveal({ itemId: item.id, correctIndex: res.correctIndex, picked: choiceIndex });
      appendRetry(res.retry);
    } finally {
      setBusy(false);
    }
  }

  function appendRetry(retry: (typeof items)[number] | undefined) {
    if (retry) setItems((prev) => [...prev, retry]);
  }

  function next() {
    if (!reveal) return;
    setAnswered((prev) => ({
      ...prev,
      [reveal.itemId]: reveal.correctIndex === reveal.picked,
    }));
    setReveal(null);
  }

  // Also the retry path: re-recording after a miss/reveal is allowed (the
  // server leaves the item ungraded until a hit or a self-grade).
  async function sendAudio(blob: Blob) {
    if (busy || speech?.phase === "correct") return;
    const prev = speech;
    setBusy(true);
    // A revealed answer stays up while a retry transcribes.
    if (prev?.phase !== "revealed") setSpeech({ itemId: item.id, phase: "busy" });
    try {
      const form = new FormData();
      form.set("sessionId", data.sessionId);
      form.set("itemId", item.id);
      form.set("audio", blob, "clip");
      const res = await submitSpeech({ data: form });
      if (res.status === "correct") {
        setSpeech({
          itemId: item.id,
          phase: "correct",
          answer: res.answer ?? "",
          transcript: res.transcript,
          hint: res.hint,
        });
      } else if (res.status === "alternative") {
        const dropped = res.dropped ?? [];
        setItems((prev) => prev.filter((it) => !dropped.includes(it.id)));
        setExcluded((prev) => ({ ...prev, [item.id]: res.excluded ?? [] }));
        setSpeech(null);
      } else if (res.status === "miss" || res.status === "heard") {
        setSpeech({
          itemId: item.id,
          phase: "revealed",
          answer: res.answer ?? "",
          alternatives: res.alternatives,
          transcript: res.transcript,
          heard: res.status === "heard",
        });
      } else {
        setSpeech(null); // alreadyAnswered — stale click, just move on
      }
    } catch {
      setSpeech(prev); // sidecar hiccup: let the learner retry the same item
    } finally {
      setBusy(false);
    }
  }

  async function giveUp() {
    if (speech || busy) return;
    setBusy(true);
    try {
      const res = await revealSpeech({
        data: { sessionId: data.sessionId, itemId: item.id },
      });
      setSpeech({
        itemId: item.id,
        phase: "revealed",
        answer: res.answer,
        alternatives: res.alternatives,
        transcript: "",
        heard: false,
      });
    } finally {
      setBusy(false);
    }
  }

  // The Pronunciation note a self-grade returns is not shown: the item closes with it.
  async function selfGrade(saidIt: boolean) {
    setBusy(true);
    try {
      const res = await submitSelfGrade({
        data: { sessionId: data.sessionId, itemId: item.id, saidIt },
      });
      appendRetry(res.retry);
      setAnswered((prev) => ({ ...prev, [item.id]: saidIt }));
      setSpeech(null);
    } finally {
      setBusy(false);
    }
  }

  async function report(kind: "wrong" | "context", note: string) {
    if (busy) return;
    setBusy(true);
    try {
      const { dropped } = await submitReport({
        data: { sessionId: data.sessionId, itemId: item.id, kind, note },
      });
      setItems((prev) => prev.filter((it) => !dropped.includes(it.id)));
      setAnswered((prev) => ({ ...prev, [item.id]: prev[item.id] ?? false }));
      setReveal(null);
      setSpeech(null);
    } finally {
      setBusy(false);
    }
  }

  function speechNext() {
    setAnswered((prev) => ({ ...prev, [item.id]: true }));
    setSpeech(null);
  }

  const bar = (
    <Bar done={answeredCount / total} count={`${answeredCount + 1} / ${total}`}>
      <ReportMenu key={item.id} passage={item.kind === "passage"} busy={busy} onReport={report} />
      {micToggle}
    </Bar>
  );

  const label = (
    <div className="flex flex-wrap items-center gap-2">
      <i className={`size-2.5 rounded-full ${track.dot}`} />
      <span className={`${LABEL_TYPE} ${track.ink}`}>{EXERCISE[item.kind].name}</span>
      <span className="text-xs font-medium text-ink-3">· {track.name}</span>
      {item.retry && (
        <span className="ml-auto inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft pr-3 pl-2 text-xs font-semibold text-accent-ink">
          <RotateCcw size={14} strokeWidth={2.2} />
          Ancora una volta
        </span>
      )}
    </div>
  );

  if (item.kind === "recognition-mcq" || item.kind === "passage") {
    return (
      <Screen
        bar={bar}
        actions={
          <>
            {item.choices.map((choice, i) => {
              const state = !reveal
                ? "idle"
                : i === reveal.correctIndex
                  ? "right"
                  : i === reveal.picked
                    ? "wrong"
                    : "off";
              return (
                <button
                  key={i}
                  type="button"
                  disabled={reveal !== null}
                  onClick={() => choose(i)}
                  className={`${CHOICE} ${CHOICE_STATE[state]}`}
                >
                  {choice}
                  {state === "right" && (
                    <Check size={18} strokeWidth={2.4} className="ml-auto shrink-0" />
                  )}
                  {state === "wrong" && (
                    <X size={18} strokeWidth={2.4} className="ml-auto shrink-0" />
                  )}
                </button>
              );
            })}
            {reveal && (
              <button type="button" onClick={next} className={BTN_PRIMARY}>
                {nextLabel}
              </button>
            )}
          </>
        }
      >
        {label}
        {item.kind === "recognition-mcq" ? (
          <>
            <p className="text-sm text-ink-3">Che cosa significa?</p>
            <p lang="pl" className="font-serif text-2xl font-bold wrap-anywhere">
              {item.prompt}
            </p>
          </>
        ) : (
          <>
            <p lang="pl" className="font-serif text-prose leading-[1.75] whitespace-pre-wrap">
              <Highlighted text={item.passage} target={item.target} />
            </p>
            <p className="font-serif text-md leading-[1.4] font-semibold">{item.question}</p>
          </>
        )}
      </Screen>
    );
  }

  const current = speech?.itemId === item.id ? speech : null;
  const listenText = (answer: string) => (item.kind === "read-aloud" ? item.sentence : answer);
  const spinner = (
    <span
      className="size-5 animate-spin rounded-full border-[2.5px] border-rule motion-reduce:animate-none"
      style={{ borderTopColor: track.color }}
    />
  );

  let verdict: React.ReactNode = null;
  let actions: React.ReactNode;
  if (!current) {
    actions = (
      <>
        <PushToTalk onRecorded={sendAudio} color={track.color} disabled={busy} />
        <button
          type="button"
          onClick={giveUp}
          disabled={busy}
          className="min-h-11 justify-self-center text-sm font-medium text-ink-3 underline underline-offset-[.2em]"
        >
          Mostra la risposta
        </button>
      </>
    );
  } else if (current.phase === "busy") {
    actions = (
      <p className="flex min-h-24 items-center justify-center gap-3 font-medium text-ink-2 sm:min-h-20">
        {spinner}
        Trascrivo…
      </p>
    );
  } else if (current.phase === "correct") {
    verdict = (
      <>
        <div className="grid gap-1 rounded bg-good-soft px-4 py-3 text-good-ink">
          <span className="flex items-center gap-2 font-semibold">
            <Check size={18} strokeWidth={2.4} />
            Giusto
          </span>
          <Heard transcript={current.transcript} />
        </div>
        <ListenButton text={listenText(current.answer)} />
        {current.hint && <PronunciationNote hint={current.hint} />}
      </>
    );
    actions = (
      <button type="button" onClick={speechNext} className={BTN_PRIMARY}>
        {nextLabel}
      </button>
    );
  } else {
    verdict = (
      <>
        <div className="grid gap-1 rounded border-[1.5px] border-rule bg-panel px-4 py-3">
          <span className={LABEL}>Risposta</span>
          <span lang="pl" className="font-serif text-2xl font-bold wrap-anywhere">
            {current.answer}
          </span>
          {current.alternatives && current.alternatives.length > 0 && (
            <span className="text-sm text-ink-2">
              anche:{" "}
              <em lang="pl" className="font-serif text-base">
                {current.alternatives.join(", ")}
              </em>
            </span>
          )}
          {current.transcript && (
            <Heard
              transcript={current.transcript}
              className={current.heard ? "font-semibold text-good-ink" : "text-ink-3"}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <ListenButton text={listenText(current.answer)} />
          {!current.heard &&
            (busy ? (
              <span className="flex min-h-12 items-center gap-3 text-sm font-medium text-ink-2">
                {spinner}
                Trascrivo…
              </span>
            ) : (
              <span className="flex items-center gap-3">
                <PushToTalk onRecorded={sendAudio} color={track.color} small />
                <span className="text-sm text-ink-3">Tieni premuto per riprovare</span>
              </span>
            ))}
        </div>
      </>
    );
    actions = (
      <>
        {item.kind === "spoken-recall" && (
          // the verdict grades recall; retries beside Ascolta only grade pronunciation
          <p className="text-center text-sm text-ink-2">
            Prima di vedere la risposta, l'avevi detto?
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => selfGrade(true)}
            className={BTN_GOOD}
          >
            <Check size={18} strokeWidth={2.4} />
            L'ho detto
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => selfGrade(false)}
            className={BTN_BAD}
          >
            <X size={18} strokeWidth={2.4} />
            Non l'ho detto
          </button>
        </div>
      </>
    );
  }

  return (
    <Screen bar={bar} actions={actions} inline={current?.phase === "correct"}>
      {label}
      {item.kind === "spoken-recall" ? (
        <>
          <p className="text-sm text-ink-3">Come si dice in polacco?</p>
          <p className="font-serif text-2xl font-bold">{item.gloss}</p>
          {excluded[item.id] && (
            <>
              {!speech && (
                <p className="flex items-center gap-2 font-semibold text-good-ink">
                  <Check size={18} strokeWidth={2.4} />
                  Giusto, ma c'è un'altra parola.
                </p>
              )}
              <p className="text-sm text-ink-2">
                Non:{" "}
                <em lang="pl" className="font-serif text-base">
                  {excluded[item.id].join(", ")}
                </em>
              </p>
            </>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-ink-3">Leggi la frase ad alta voce.</p>
          <p lang="pl" className="font-serif text-lg leading-[1.55] font-medium">
            {item.sentence}
          </p>
        </>
      )}
      {verdict}
    </Screen>
  );
}

/**
 * Narrow: the content scrolls and the actions sit at the bottom, in thumb reach.
 * Wide: the actions sit beside the content, or under it when `inline` (a lone button
 * leaves a column of its own empty).
 */
function Screen({
  bar,
  actions,
  inline = false,
  children,
}: {
  bar: React.ReactNode;
  actions?: React.ReactNode;
  inline?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col bg-paper font-sans text-base text-pretty text-ink">
      {bar}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row lg:items-center-safe lg:justify-center lg:gap-12 lg:overflow-auto lg:px-12 lg:py-8">
        <main className="min-h-0 flex-1 overflow-auto px-5 pt-5 pb-3 sm:flex sm:flex-col sm:justify-center-safe sm:px-7 lg:flex-[0_1_34rem] lg:overflow-visible lg:p-0">
          <div className="mx-auto grid w-full max-w-[36rem] gap-4">
            {children}
            {inline && <div className="mt-1 hidden sm:flex">{actions}</div>}
          </div>
        </main>
        {actions && (
          <div
            className={`grid shrink-0 gap-2 px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] sm:w-[min(42%,400px)] sm:content-center sm:overflow-auto sm:p-4 lg:w-[340px] lg:overflow-visible lg:p-0 ${inline ? "sm:hidden" : ""}`}
          >
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

/** Top bar: back, progress (`done` 0..1), then the screen's own buttons. */
function Bar({
  done,
  count,
  children,
}: {
  done: number;
  count?: string;
  children: React.ReactNode;
}) {
  return (
    <header className="relative flex shrink-0 items-center gap-1 border-b border-rule py-2 pr-2 pl-1 sm:py-0.5 lg:px-[max(8px,calc((100%_-_960px)/2))]">
      <Link to="/" aria-label="Indietro" className={ICON_BUTTON}>
        <ArrowLeft size={20} />
      </Link>
      <div className="flex min-w-0 flex-1 items-center gap-3 px-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-rule">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.round(done * 100)}%` }}
          />
        </div>
        {count && (
          <span className="text-sm font-semibold whitespace-nowrap text-ink-2 tabular-nums">
            {count}
          </span>
        )}
      </div>
      {children}
    </header>
  );
}

const POPOVER =
  "absolute top-full right-2 z-20 mt-1 grid w-[min(300px,calc(100%-16px))] rounded bg-panel p-3 shadow-card";

function ReportMenu({
  passage,
  busy,
  onReport,
}: {
  passage: boolean;
  busy: boolean;
  onReport: (kind: "wrong" | "context", note: string) => void;
}) {
  const [step, setStep] = useState<"menu" | "note" | null>(null);
  const [note, setNote] = useState("");
  const option =
    "grid min-h-12 gap-px rounded border-[1.5px] border-rule bg-panel px-3 py-2 text-left";
  return (
    <>
      <button
        type="button"
        onClick={() => setStep(step ? null : "menu")}
        disabled={busy}
        aria-label="Segnala"
        aria-expanded={step !== null}
        className={ICON_BUTTON}
      >
        <Flag size={20} />
      </button>
      {step === "menu" && (
        <div className={`${POPOVER} gap-2`}>
          <span className={LABEL}>Segnala</span>
          <button type="button" onClick={() => setStep("note")} className={option}>
            <b className="font-semibold">
              {passage ? "Domanda sbagliata" : "Significato sbagliato"}
            </b>
            <small className="text-sm text-ink-3">Esce dalla pratica fino alla revisione</small>
          </button>
          {!passage && (
            <button type="button" onClick={() => onReport("context", "")} className={option}>
              <b className="font-semibold">Serve il contesto</b>
              <small className="text-sm text-ink-3">
                Non chiederla più da sola: solo in una frase
              </small>
            </button>
          )}
        </div>
      )}
      {step === "note" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onReport("wrong", note);
          }}
          className={`${POPOVER} gap-2`}
        >
          <label htmlFor="report-note" className="text-sm font-semibold text-ink-2">
            Cosa non va? <span className="font-normal text-ink-3">(facoltativo)</span>
          </label>
          <textarea
            id="report-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            autoFocus
            className="rounded border-[1.5px] border-rule bg-panel px-3 py-2 font-serif text-base"
          />
          <p className="text-sm text-ink-3">
            Esce dalla pratica fino alla revisione a fine sessione.
          </p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setStep(null)} className={BTN_QUIET}>
              Annulla
            </button>
            <button type="submit" disabled={busy} className={BTN_PRIMARY}>
              Segnala
            </button>
          </div>
        </form>
      )}
    </>
  );
}

function Heard({ transcript, className = "" }: { transcript: string; className?: string }) {
  return (
    <span className={`text-sm ${className}`}>
      Ho sentito:{" "}
      <q lang="pl" className="font-serif text-base">
        {transcript}
      </q>
    </span>
  );
}

function End({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid justify-items-center gap-3 pt-10 text-center sm:pt-0">
      <Tick />
      <h1 className="font-serif text-xl font-bold">{title}</h1>
      {children}
    </div>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span className="inline-grid h-6 min-w-6 place-items-center rounded-full bg-accent-soft px-2 font-sans text-xs font-bold text-accent-ink tabular-nums">
      {n}
    </span>
  );
}

/** The passage with every occurrence of the target word in bold. */
function Highlighted({ text, target }: { text: string; target: string }) {
  // split keeps the capture group: odd indexes are the matches.
  const parts = text.split(wordPattern(target, "giu"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <strong
            key={i}
            className="font-bold text-receptive-ink underline decoration-receptive/45 decoration-2 underline-offset-[.25em]"
          >
            {p}
          </strong>
        ) : (
          p
        ),
      )}
    </>
  );
}

const RECAP_DELAY_MS = 2500;

function SessionNote({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<{ line: string; dayCompleted: boolean } | null>(null);
  useEffect(() => {
    getSummary({ data: { sessionId } }).then((s) => {
      if (!s) return;
      setSummary(s);
      // Leave the slot line on screen for a moment before the recap.
      if (s.dayCompleted) setTimeout(() => navigate({ to: "/recap" }), RECAP_DELAY_MS);
    });
  }, [sessionId, navigate]);
  if (!summary) return null;
  return (
    <>
      <p className="font-semibold text-accent-ink">{summary.line}</p>
      {summary.dayCompleted && (
        <p className="text-sm text-ink-3">Apro il riepilogo della giornata…</p>
      )}
    </>
  );
}

function PronunciationNote({ hint }: { hint: Hint }) {
  return (
    <p className="flex items-center gap-2 text-sm text-ink-2">
      <i className="size-2 shrink-0 rounded-full bg-pronunciation" />
      <span>
        <b lang="pl" className="font-serif font-semibold text-pronunciation-ink">
          {hint.lemma}
        </b>
        : {hintText(hint)}
      </span>
    </p>
  );
}

/**
 * "pronuncia difficile · torna tra 9 h". Bands over FSRS difficulty (1..10):
 * one Good lands ≈2.1, one Hard ≈5.1, one Again ≈6.4, repeated Agains ≥8.8.
 * ponytail: calibration knob — retune the 4/7 cut-offs if the bands feel off.
 */
function hintText(h: Hint): string {
  const band = h.difficulty < 4 ? "facile" : h.difficulty < 7 ? "media" : "difficile";
  const min = Math.max(1, Math.round((new Date(h.due).getTime() - Date.now()) / 60000));
  const days = Math.round(min / 1440);
  const when =
    min < 60
      ? `${min} min`
      : min < 1440
        ? `${Math.round(min / 60)} h`
        : `${days} ${days === 1 ? "giorno" : "giorni"}`;
  return `pronuncia ${band} · torna tra ${when}`;
}
