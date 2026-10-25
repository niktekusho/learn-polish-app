import { createServerFn } from "@tanstack/react-start";
import { Check, ListChecks, RefreshCw, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { z } from "zod";
import { BTN_PRIMARY, ERROR_LINE, RETRY, TOOL } from "./ui";

// Server-only: get (and lazily generate + cache) the comprehension check.
const getCheckFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ textId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { getComprehensionCheck } = await import("#/comprehension/service");
    return getComprehensionCheck(db, data.textId);
  });

// Server-only: nuke the cached questions and generate fresh.
const regenerateCheckFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ textId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { regenerateComprehensionCheck } = await import("#/comprehension/service");
    return regenerateComprehensionCheck(db, data.textId);
  });

type Question = { question: string; choices: string[]; correctIndex: number };

// End-of-text comprehension check (roadmap): Italian MCQs about the text,
// answered all-at-once, graded client-side. The answer key travels to the
// client deliberately — single-user local app, nothing persisted, so a
// server-grading round-trip buys nothing (unlike Practice, which feeds FSRS).
export function ComprehensionCheck({
  textId,
  onGraded,
}: {
  textId: number;
  onGraded?: () => void; // the check was answered: an Episode counts as read
}) {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [graded, setGraded] = useState(false);

  async function load(fn: typeof getCheckFn) {
    setLoading(true);
    setError(false);
    setQuestions(null);
    setAnswers({});
    setGraded(false);
    try {
      const r = await fn({ data: { textId } });
      setQuestions(r.questions);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => void load(getCheckFn), [textId]);

  const answered = questions?.filter((_, i) => answers[i] !== undefined).length ?? 0;
  const allAnswered = questions !== null && answered === questions.length;
  const score = questions?.filter((q, i) => answers[i] === q.correctIndex).length ?? 0;

  if (loading) {
    return (
      <CheckShell>
        <div className="mt-4 grid animate-pulse gap-2 motion-reduce:animate-none">
          {["w-[70%]", "w-full", "w-full", "w-[85%]"].map((w, i) => (
            <i key={i} className={`block h-3 rounded-full bg-rule ${w}`} />
          ))}
        </div>
        <p className="mt-3 text-xs font-medium text-ink-3">Preparo le domande…</p>
      </CheckShell>
    );
  }
  if (error || questions === null) {
    return (
      <CheckShell>
        <p className={`${ERROR_LINE} mt-2.5`}>
          Domande non generate.
          <button type="button" onClick={() => load(getCheckFn)} className={RETRY}>
            Riprova
          </button>
        </p>
      </CheckShell>
    );
  }

  return (
    <CheckShell
      aside={
        <>
          {graded && (
            <span className="rounded-full bg-accent-soft px-3 py-0.5 font-bold text-accent-ink tabular-nums">
              {score} / {questions.length}
            </span>
          )}
          <button type="button" onClick={() => load(regenerateCheckFn)} className={TOOL}>
            <RefreshCw size={15} />
            Rigenera domande
          </button>
        </>
      }
    >
      <ol className="mt-3.5 grid gap-5.5">
        {questions.map((q, qi) => (
          <li key={qi}>
            <p className="mb-2.5 font-serif text-md leading-[1.4] font-semibold">
              <span className="font-sans text-sm text-ink-3">{qi + 1}. </span>
              {q.question}
            </p>
            <div className="grid gap-2">
              {q.choices.map((choice, ci) => {
                const picked = answers[qi] === ci;
                const right = graded && ci === q.correctIndex;
                const wrong = graded && picked && !right;
                const cls = right
                  ? "border-good bg-good-soft text-good-ink"
                  : wrong
                    ? "border-bad bg-bad-soft text-bad-ink"
                    : graded
                      ? "border-rule bg-panel opacity-55"
                      : picked
                        ? "border-accent bg-accent-soft"
                        : "border-rule bg-panel";
                return (
                  <button
                    key={ci}
                    type="button"
                    disabled={graded}
                    aria-pressed={picked}
                    onClick={() => setAnswers((prev) => ({ ...prev, [qi]: ci }))}
                    className={`flex min-h-12 w-full items-center gap-2.5 rounded border-[1.5px] px-3.5 py-2.5 text-left font-serif text-[16px] leading-[1.35] ${cls}`}
                  >
                    {choice}
                    {right && <Check size={18} strokeWidth={2.4} className="ml-auto shrink-0" />}
                    {wrong && <X size={18} strokeWidth={2.4} className="ml-auto shrink-0" />}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ol>

      {!graded && (
        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            disabled={!allAnswered}
            onClick={() => {
              setGraded(true);
              onGraded?.();
            }}
            className={BTN_PRIMARY}
          >
            <ListChecks size={20} />
            Verifica
          </button>
          <small className="text-sm text-ink-3 tabular-nums">
            {answered} di {questions.length}
          </small>
        </div>
      )}
    </CheckShell>
  );
}

function CheckShell({ aside, children }: { aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-7 border-t border-rule pt-4.5 font-sans text-base">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-serif text-lg font-bold">Verifica comprensione</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
