import { Link, createFileRoute, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ALargeSmall, ArrowLeft, ArrowRight, BookCheck, ListChecks, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { ComprehensionCheck } from "#/reader/ComprehensionCheck";
import { NamePanel, WordPanel } from "#/reader/WordPanel";
import { isName, nameForm } from "#/reader/name";
import type { KnowledgeFlags, ReaderToken } from "#/reader/types";
import { BTN_PRIMARY, BTN_QUIET, ICON_BUTTON, LABEL, Tick } from "#/ui";

// Load a text and its tokens in reading order. `known` / `stillLearning` are
// computed server-side; the client never sees the raw FSRS state.
const getText = createServerFn()
  .validator((textId: unknown) => z.coerce.number().int().parse(textId))
  .handler(async ({ data: textId }) => {
    const { db, schema } = await import("#/db/index");
    const { and, asc, eq } = await import("drizzle-orm");
    const { knowledgeFlags } = await import("#/reader/knowledge");

    const [text] = db
      .select()
      .from(schema.sourceText)
      .where(eq(schema.sourceText.id, textId))
      .all();
    if (!text) throw notFound();

    const rows = db
      .select({
        id: schema.token.id,
        surface: schema.token.surface,
        isSpace: schema.token.isSpace,
        position: schema.token.position,
        sentenceIndex: schema.token.sentenceIndex,
        lemmaId: schema.lemma.id,
        lemma: schema.lemma.lemma,
        pos: schema.lemma.pos,
        tags: schema.token.tags,
        receptiveState: schema.knowledge.state,
      })
      .from(schema.token)
      .leftJoin(schema.lemma, eq(schema.token.lemmaId, schema.lemma.id))
      .leftJoin(
        schema.knowledge,
        and(
          eq(schema.knowledge.lemmaId, schema.token.lemmaId),
          eq(schema.knowledge.track, "receptive"),
        ),
      )
      .where(eq(schema.token.textId, textId))
      .orderBy(asc(schema.token.position))
      .all();

    const tokens: ReaderToken[] = rows.map(({ receptiveState, ...t }) => ({
      ...t,
      ...knowledgeFlags(receptiveState),
    }));

    // MWE occurrences detected at import (contiguous, pos='MWE' lemmas).
    const mwes = db
      .select({
        lemmaId: schema.mweOccurrence.lemmaId,
        headword: schema.lemma.lemma,
        startPosition: schema.mweOccurrence.startPosition,
        endPosition: schema.mweOccurrence.endPosition,
        sentenceIndex: schema.mweOccurrence.sentenceIndex,
      })
      .from(schema.mweOccurrence)
      .innerJoin(schema.lemma, eq(schema.mweOccurrence.lemmaId, schema.lemma.id))
      .where(eq(schema.mweOccurrence.textId, textId))
      .all();

    const [story] = text.storyId
      ? db
          .select({ title: schema.story.title, total: schema.story.plannedEpisodes })
          .from(schema.story)
          .where(eq(schema.story.id, text.storyId))
          .all()
      : [];

    return { text, tokens, mwes, story: story ?? null };
  });

// An Episode is read: counts for the day and starts the next episode's generation.
const markEpisodeReadFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ textId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { appStoryService } = await import("#/story/server");
    return appStoryService().markEpisodeRead(data.textId);
  });

export const Route = createFileRoute("/read/$textId")({
  component: Reader,
  loader: ({ params }) => getText({ data: params.textId }),
});

type MweInfo = {
  lemmaId: number;
  headword: string;
  startPosition: number;
  endPosition: number;
  sentenceIndex: number;
};

function Reader() {
  const { text, tokens, mwes, story } = Route.useLoaderData();
  const navigate = useNavigate();
  const router = useRouter();
  const [readResult, setReadResult] = useState<{
    line: string;
    storyFinished: boolean;
    dayCompleted: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<ReaderToken | null>(null);
  // End-of-text comprehension check; the click is the "I read this" signal.
  const [checking, setChecking] = useState(false);
  // Live verdict overrides so marking updates highlights without a reload.
  const [overrides, setOverrides] = useState<Record<number, KnowledgeFlags>>({});

  // Token position -> covering MWE occurrence, for underline + panel link.
  const mweAt = useMemo(() => {
    const map = new Map<number, MweInfo>();
    for (const m of mwes) {
      for (let p = m.startPosition; p <= m.endPosition; p++) map.set(p, m);
    }
    return map;
  }, [mwes]);

  const flagsOf = (t: ReaderToken): KnowledgeFlags =>
    t.lemmaId != null && overrides[t.lemmaId]
      ? overrides[t.lemmaId]
      : { known: t.known, stillLearning: t.stillLearning };
  // A Name is never vocabulary: no highlight.
  const isUnknown = (t: ReaderToken) => t.lemmaId != null && !isName(t.pos) && !flagsOf(t).known;

  function markGraded(lemmaId: number, flags: KnowledgeFlags) {
    setOverrides((prev) => ({ ...prev, [lemmaId]: flags }));
  }

  async function markRead() {
    if (!story || readResult) return;
    const res = await markEpisodeReadFn({ data: { textId: text.id } });
    setReadResult(res);
    // The slot line stays up for a moment; a finished story keeps its own screen.
    if (res.dayCompleted && !res.storyFinished) {
      setTimeout(() => navigate({ to: "/recap" }), 2500);
    }
  }

  const [size, setSize] = useReadingSize();
  const title = story ? `Episodio ${text.episodeNumber}` : text.title || `Testo #${text.id}`;

  return (
    <div className="flex h-dvh flex-col bg-paper font-sans text-base text-ink">
      <header className="relative flex shrink-0 items-center gap-1 border-b border-rule py-2 pr-2 pl-1 sm:py-0.5">
        <Link to="/" aria-label="Indietro" className={ICON_BUTTON}>
          <ArrowLeft size={20} />
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm text-ink-2">
          {story && `${story.title} · episodio ${text.episodeNumber} di ${story.total}`}
        </span>
        <ReadingSize size={size} onChange={setSize} />
      </header>
      <div className="relative flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto px-5 pt-5 pb-8 sm:px-7 lg:px-12 lg:py-10">
          <div className="mx-auto max-w-[36rem]">
            <h1 className="mb-4 font-serif text-xl font-bold text-balance lg:text-2xl">{title}</h1>
            <article
              lang="pl"
              className="font-serif text-prose wrap-break-word whitespace-pre-wrap"
              style={{ "--text-prose": `${size}px` } as React.CSSProperties}
            >
              {tokens.map((t, i) => {
                if (t.isSpace || t.lemmaId == null) {
                  return <span key={i}>{t.surface}</span>;
                }
                const sel = selected?.id === t.id ? " outline-2 outline-accent" : "";
                if (isName(t.pos)) {
                  if (!nameForm(t.surface, t.lemma ?? "", t.tags)) {
                    return <span key={i}>{t.surface}</span>;
                  }
                  return (
                    <span
                      key={i}
                      onClick={() => setSelected(t)}
                      className={`${WORD} text-word-name ${sel}`}
                    >
                      {t.surface}
                    </span>
                  );
                }
                const mark = !isUnknown(t)
                  ? ""
                  : flagsOf(t).stillLearning
                    ? " text-word-learning"
                    : " bg-word-new";
                const mwe = mweAt.has(t.position)
                  ? " underline decoration-word-mwe decoration-dotted decoration-2 underline-offset-[0.3em]"
                  : "";
                return (
                  <span
                    key={i}
                    onClick={() => setSelected(t)}
                    className={`${WORD}${mark}${mwe}${sel}`}
                  >
                    {t.surface}
                  </span>
                );
              })}
            </article>

            {checking && (
              <ComprehensionCheck textId={text.id} onGraded={story ? markRead : undefined} />
            )}

            <div className="mt-7 grid justify-items-center gap-3 border-t border-rule pt-5 text-center">
              <span className={LABEL}>
                {story ? `Fine dell'episodio ${text.episodeNumber}` : "Fine del testo"}
              </span>
              {!checking && (
                <button type="button" onClick={() => setChecking(true)} className={BTN_PRIMARY}>
                  <ListChecks size={20} />
                  Verifica comprensione
                </button>
              )}
              {story &&
                (readResult ? (
                  <span className="inline-flex items-center gap-2 font-semibold text-accent-ink">
                    <Tick />
                    Letto · {readResult.line}
                  </span>
                ) : text.readAt ? (
                  <span className="font-medium text-ink-3">Già letto</span>
                ) : (
                  <button type="button" onClick={markRead} className={BTN_QUIET}>
                    <BookCheck size={20} />
                    Segna come letto
                  </button>
                ))}
            </div>

            {story && readResult?.storyFinished && (
              <div className="mt-5 grid justify-items-start gap-3 rounded-lg bg-card p-5 shadow-card">
                <Tick />
                <h2 className="font-serif text-lg font-bold">Storia completata</h2>
                <p className="text-sm text-ink-2">
                  {story.title} · {story.total} episodi letti
                </p>
                <div className="flex flex-wrap gap-3">
                  <Link to="/story" className={BTN_PRIMARY}>
                    <Sparkles size={20} />
                    Scegli la prossima storia
                  </Link>
                  {readResult.dayCompleted && (
                    <Link to="/recap" className={BTN_QUIET}>
                      Riepilogo della giornata
                      <ArrowRight size={20} />
                    </Link>
                  )}
                </div>
              </div>
            )}
          </div>
        </main>

        <aside className="contents sm:flex sm:w-[min(42%,380px)] sm:shrink-0 sm:flex-col sm:border-l sm:border-rule sm:bg-panel">
          {!selected && (
            <p className="hidden p-4 text-sm text-ink-3 sm:mt-auto sm:block">
              Tocca una parola per vederne il significato.
            </p>
          )}
          {selected && isName(selected.pos) && (
            <NamePanel token={selected} onClose={() => setSelected(null)} />
          )}
          {selected && !isName(selected.pos) && (
            <WordPanel
              token={selected}
              sentence={tokens
                .filter((t) => t.sentenceIndex === selected.sentenceIndex)
                .map((t) => t.surface)
                .join("")}
              mwe={(() => {
                const m = mweAt.get(selected.position);
                if (!m || selected.pos === "MWE") return null;
                return { lemmaId: m.lemmaId, headword: m.headword };
              })()}
              onSelectMwe={(m) => {
                const occ = mweAt.get(selected.position);
                // Swap the panel to a synthetic token for the MWE tracked unit.
                // Surface is the span as written in the text, which can differ from the headword.
                setSelected({
                  id: tokens.find((t) => t.position === occ?.startPosition)?.id ?? selected.id,
                  surface: occ
                    ? tokens
                        .filter(
                          (t) => t.position >= occ.startPosition && t.position <= occ.endPosition,
                        )
                        .map((t) => t.surface)
                        .join("")
                        .trim()
                    : m.headword,
                  isSpace: false,
                  position: occ?.startPosition ?? selected.position,
                  sentenceIndex: selected.sentenceIndex,
                  lemmaId: m.lemmaId,
                  lemma: m.headword,
                  pos: "MWE",
                  tags: null,
                  known: false,
                  stillLearning: false,
                });
              }}
              onSuppressed={() => {
                setSelected(null);
                router.invalidate();
              }}
              onPromoted={(formula) => {
                setSelected({ ...selected, ...formula, known: false, stillLearning: false });
                router.invalidate();
              }}
              onGraded={markGraded}
              onClose={() => setSelected(null)}
            />
          )}
        </aside>
      </div>
    </div>
  );
}

// Words pad vertically to fill the line box: a short word is otherwise a few pixels wide.
const WORD = "-mx-[.08em] cursor-pointer rounded-word box-decoration-clone px-[.08em] py-[.3em]";

const SIZE_KEY = "reader-size";
type Size = "16" | "18";

// Per device: the phone and the Mac keep their own choice.
// Blocked storage (private window, cleared site data) throws: the size then lasts the visit.
function useReadingSize(): [Size, (s: Size) => void] {
  const [size, setSize] = useState<Size>("18");
  useEffect(() => {
    try {
      if (localStorage.getItem(SIZE_KEY) === "16") setSize("16");
    } catch {}
  }, []);
  return [
    size,
    (s) => {
      setSize(s);
      try {
        localStorage.setItem(SIZE_KEY, s);
      } catch {}
    },
  ];
}

function ReadingSize({ size, onChange }: { size: Size; onChange: (s: Size) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-label="Dimensione testo"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={ICON_BUTTON}
      >
        <ALargeSmall size={20} />
      </button>
      {open && (
        <div className="absolute top-full mt-1 right-2 z-20 grid min-w-[200px] gap-2 rounded bg-panel p-3 shadow-card">
          <span className={LABEL}>Dimensione testo</span>
          <div className="grid grid-cols-2 gap-1 rounded bg-paper p-1">
            {(["16", "18"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={size === v}
                onClick={() => {
                  onChange(v);
                  setOpen(false);
                }}
                style={{ fontSize: `${v}px` }}
                className="min-h-11 rounded font-serif text-ink-2 aria-pressed:bg-panel aria-pressed:font-semibold aria-pressed:text-ink aria-pressed:shadow-sm"
              >
                Aa {v}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
