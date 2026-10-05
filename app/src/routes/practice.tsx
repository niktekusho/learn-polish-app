import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Flag, Mic, MicOff, Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { PushToTalk } from "#/audio/recorder";

// Build a new session, or resume the held one by id (reload/refocus). No LLM
// calls: buildSession only reads cached glosses.
const startSession = createServerFn()
  .validator((d: unknown) =>
    z.object({ sessionId: z.string().nullable(), mic: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { buildSession, resumeSession } = await import("#/practice/session");
    if (data.sessionId) {
      const resumed = resumeSession(data.sessionId);
      if (resumed) return resumed;
    }
    return buildSession(db, { mic: data.mic });
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

// Flag the item's lemma as "requires attention" (fixed in Maintenance).
const submitReport = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ sessionId: z.string(), itemId: z.string(), note: z.string().max(500) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { reportItem } = await import("#/practice/session");
    reportItem(db, data.sessionId, data.itemId, data.note);
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
  | { itemId: string; phase: "correct"; answer: string; transcript: string }
  | {
      itemId: string;
      phase: "revealed";
      answer: string;
      transcript: string;
      heard: boolean; // spoken recall: a retry after the reveal was heard
    };

type Hint = { lemma: string; difficulty: number; due: Date };

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

  const items = data.items;
  const [answered, setAnswered] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(data.answered.map((a) => [a.itemId, a.correct])),
  );
  const [reveal, setReveal] = useState<{
    itemId: string;
    correctIndex: number;
    picked: number;
  } | null>(null);
  const [speech, setSpeech] = useState<SpeechPhase | null>(null);
  const [busy, setBusy] = useState(false);
  // Last Pronunciation grade; stays up (it names its word) until the next one.
  const [hint, setHint] = useState<Hint | null>(null);

  const micToggle = (
    <button
      type="button"
      onClick={() =>
        // Toggling rebuilds the session: the mix itself changes with the mic.
        navigate({ to: "/practice", search: { mic: !mic }, replace: true })
      }
      className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
      title={mic ? "Speaking exercises on" : "Speaking exercises off"}
    >
      {mic ? <Mic size={14} /> : <MicOff size={14} />}
      {mic ? "Mic on" : "Mic off"}
    </button>
  );

  if (items.length === 0) {
    return (
      <Shell toolbar={micToggle}>
        <p className="text-lg">Nothing due right now. 🎉</p>
      </Shell>
    );
  }

  const total = items.length;
  const answeredCount = Object.keys(answered).length;
  const correctCount = Object.values(answered).filter(Boolean).length;
  const index = items.findIndex((it) => !(it.id in answered));

  if (index === -1) {
    return (
      <Shell toolbar={micToggle}>
        <h2 className="text-xl font-bold">Session complete</h2>
        <p className="mt-2 text-gray-700">
          Reviewed {total} — {correctCount} correct.
        </p>
      </Shell>
    );
  }

  const item = items[index];

  async function choose(choiceIndex: number) {
    if (reveal || busy || item.kind !== "recognition-mcq") return;
    setBusy(true);
    try {
      const res = await submitAnswer({
        data: { sessionId: data.sessionId, itemId: item.id, choiceIndex },
      });
      setReveal({ itemId: item.id, correctIndex: res.correctIndex, picked: choiceIndex });
    } finally {
      setBusy(false);
    }
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
    setSpeech({ itemId: item.id, phase: "busy" });
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
        });
        if (res.hint) setHint(res.hint);
      } else if (res.status === "miss" || res.status === "heard") {
        setSpeech({
          itemId: item.id,
          phase: "revealed",
          answer: res.answer ?? "",
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
        transcript: "",
        heard: false,
      });
    } finally {
      setBusy(false);
    }
  }

  async function selfGrade(saidIt: boolean) {
    setBusy(true);
    try {
      const res = await submitSelfGrade({
        data: { sessionId: data.sessionId, itemId: item.id, saidIt },
      });
      if (res.hint) setHint(res.hint);
      setAnswered((prev) => ({ ...prev, [item.id]: saidIt }));
      setSpeech(null);
    } finally {
      setBusy(false);
    }
  }

  async function report() {
    if (busy) return;
    const note = window.prompt(
      "Report this exercise — what is wrong? (optional)\nIt leaves practice until fixed in Maintenance.",
    );
    if (note === null) return;
    setBusy(true);
    try {
      await submitReport({ data: { sessionId: data.sessionId, itemId: item.id, note } });
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

  return (
    <Shell toolbar={micToggle}>
      <div className="flex items-center justify-between text-sm text-gray-500">
        <span>
          {answeredCount + 1} / {total}
        </span>
        <button
          type="button"
          onClick={report}
          disabled={busy}
          className="flex items-center gap-1 hover:text-red-600"
          title="Report a problem with this exercise"
        >
          <Flag size={14} /> Report
        </button>
      </div>
      {hint && <p className="mt-1 text-sm text-gray-500">{hintText(hint)}</p>}

      {item.kind === "recognition-mcq" && (
        <>
          <div className="mt-2 text-3xl font-bold">{item.prompt}</div>
          <div className="mt-6 space-y-2">
            {item.choices.map((choice, i) => {
              const revealed = reveal !== null;
              const isCorrect = i === reveal?.correctIndex;
              const isPicked = i === reveal?.picked;
              const cls = !revealed
                ? "border-gray-300 hover:bg-gray-50"
                : isCorrect
                  ? "border-green-500 bg-green-50"
                  : isPicked
                    ? "border-red-500 bg-red-50"
                    : "border-gray-200 opacity-60";
              return (
                <button
                  key={i}
                  type="button"
                  disabled={revealed}
                  onClick={() => choose(i)}
                  className={`block w-full rounded border px-4 py-2 text-left ${cls}`}
                >
                  {choice}
                </button>
              );
            })}
          </div>
          {reveal && (
            <button
              type="button"
              onClick={next}
              className="mt-6 rounded bg-blue-600 px-4 py-2 font-medium text-white"
            >
              {index + 1 < total ? "Next" : "Finish"}
            </button>
          )}
        </>
      )}

      {(item.kind === "spoken-recall" || item.kind === "read-aloud") && (
        <>
          {item.kind === "spoken-recall" ? (
            <>
              <div className="mt-2 text-sm text-gray-500">Say it in Polish:</div>
              <div className="mt-1 text-3xl font-bold">{item.gloss}</div>
            </>
          ) : (
            <>
              <div className="mt-2 text-sm text-gray-500">Read aloud:</div>
              <div className="mt-1 text-2xl font-medium leading-relaxed">{item.sentence}</div>
            </>
          )}

          {(!speech || speech.itemId !== item.id) && (
            <div className="mt-6 flex flex-col items-center gap-8 sm:items-start sm:gap-3">
              <PushToTalk onRecorded={sendAudio} disabled={busy} />
              <button
                type="button"
                onClick={giveUp}
                disabled={busy}
                className="text-sm text-gray-500 underline"
              >
                Show answer
              </button>
            </div>
          )}

          {speech?.phase === "busy" && <p className="mt-6 text-gray-500">Transcribing…</p>}

          {speech?.phase === "correct" && (
            <div className="mt-6">
              <div className="rounded border border-green-500 bg-green-50 px-4 py-3">
                ✓ Correct — heard “{speech.transcript}”
              </div>
              <ListenButton text={item.kind === "read-aloud" ? item.sentence : speech.answer} />
              <button
                type="button"
                onClick={speechNext}
                className="mt-4 rounded bg-blue-600 px-4 py-2 font-medium text-white"
              >
                {index + 1 < total ? "Next" : "Finish"}
              </button>
            </div>
          )}

          {speech?.phase === "revealed" && (
            <div className="mt-6">
              <div className="rounded border border-gray-300 bg-gray-50 px-4 py-3">
                <div className="text-2xl font-bold">{speech.answer}</div>
                {speech.transcript ? (
                  <div
                    className={`mt-1 text-sm ${speech.heard ? "text-green-700" : "text-gray-500"}`}
                  >
                    {speech.heard ? "✓ " : ""}Heard: “{speech.transcript}”
                  </div>
                ) : null}
              </div>
              <ListenButton text={item.kind === "read-aloud" ? item.sentence : speech.answer} />
              {!speech.heard && (
                <div className="mt-4 flex justify-center sm:justify-start">
                  <PushToTalk onRecorded={sendAudio} disabled={busy} />
                </div>
              )}
              {item.kind === "spoken-recall" && (
                // the verdict grades recall; retries above only grade pronunciation
                <p className="mt-4 text-sm text-gray-600">
                  Before the answer showed, had you said it?
                </p>
              )}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => selfGrade(true)}
                  className="rounded bg-green-600 px-4 py-2 font-medium text-white"
                >
                  I said it
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => selfGrade(false)}
                  className="rounded bg-red-600 px-4 py-2 font-medium text-white"
                >
                  I didn’t
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

/**
 * "🗣 kot: hard to say · back in 6 min". Bands over FSRS difficulty (1..10):
 * one Good lands ≈2.1, one Hard ≈5.1, one Again ≈6.4, repeated Agains ≥8.8.
 * ponytail: calibration knob — retune the 4/7 cut-offs if the bands feel off.
 */
function hintText(h: Hint): string {
  const band = h.difficulty < 4 ? "easy" : h.difficulty < 7 ? "medium" : "hard";
  const min = Math.max(1, Math.round((new Date(h.due).getTime() - Date.now()) / 60000));
  const when =
    min < 60
      ? `${min} min`
      : min < 1440
        ? `${Math.round(min / 60)} h`
        : `${Math.round(min / 1440)} days`;
  return `🗣 ${h.lemma}: ${band} to say · back in ${when}`;
}

/** Hear the target via the browser's own TTS (pl-PL voice from the OS). */
function speak(text: string) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "pl-PL";
  // ponytail: first Polish voice the OS offers; no voice picker. If none is
  // installed the browser falls back to its default voice (wrong accent).
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("pl"));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

function ListenButton({ text }: { text: string }) {
  if (typeof speechSynthesis === "undefined") return null;
  return (
    <button
      type="button"
      onClick={() => speak(text)}
      className="mt-3 flex items-center gap-1 rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
    >
      <Volume2 size={16} /> Listen
    </button>
  );
}

function Shell({ children, toolbar }: { children: React.ReactNode; toolbar?: React.ReactNode }) {
  return (
    // pb-48: room for the bottom-floating mic button on mobile
    <div className="mx-auto max-w-xl p-8 pb-48 sm:pb-8">
      <div className="flex items-center justify-between">
        <Link to="/" className="text-sm text-blue-600 underline">
          ← Home
        </Link>
        {toolbar}
      </div>
      <h1 className="mt-2 text-2xl font-bold">Practice</h1>
      <div className="mt-6">{children}</div>
    </div>
  );
}
