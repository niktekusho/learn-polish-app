import { Link, createFileRoute, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { z } from "zod";
import { ComprehensionCheck } from "#/reader/ComprehensionCheck";
import { NamePanel, WordPanel } from "#/reader/WordPanel";
import { isName, nameLabel } from "#/reader/name";
import type { KnowledgeFlags, ReaderToken } from "#/reader/types";

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

// Batch-mark every still-New word in a text as known (grade Easy) in ONE
// transaction. Excludes words the user explicitly marked "still learning"
// (Learning/Relearning) — the batch must not overwrite an explicit judgment.
const batchMarkKnown = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ textId: z.number().int() }).parse(d))
  .handler(async ({ data }): Promise<{ lemmaIds: number[] }> => {
    const { db } = await import("#/db/index");
    const { markNewKnown } = await import("#/reader/mark");
    return { lemmaIds: markNewKnown(db, data.textId) };
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
  // A Name is never vocabulary: no highlight, no batch mark.
  const isUnknown = (t: ReaderToken) => t.lemmaId != null && !isName(t.pos) && !flagsOf(t).known;

  // Batch only burns never-touched (New) words: unknown and not still-learning.
  const batchEligible = useMemo(() => {
    const ids = new Set<number>();
    for (const t of tokens) {
      if (t.lemmaId == null || isName(t.pos)) continue;
      const f = flagsOf(t);
      if (!f.known && !f.stillLearning) ids.add(t.lemmaId);
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens, overrides]);

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

  async function markAllNewKnown() {
    if (batchEligible.size === 0) return;
    const { lemmaIds } = await batchMarkKnown({ data: { textId: text.id } });
    setOverrides((prev) => {
      const next = { ...prev };
      for (const id of lemmaIds) next[id] = { known: true, stillLearning: false };
      return next;
    });
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <Link to="/" className="text-sm text-blue-600 underline">
        ← All texts
      </Link>
      {story && (
        <p className="mt-2 text-sm text-gray-600">
          {story.title} · episodio {text.episodeNumber} di {story.total}
        </p>
      )}
      <div className="mt-2 flex items-center justify-between">
        <h1 className="text-2xl font-bold">{text.title || `Text #${text.id}`}</h1>
        <button
          type="button"
          onClick={markAllNewKnown}
          disabled={batchEligible.size === 0}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          Mark {batchEligible.size} new word{batchEligible.size === 1 ? "" : "s"} known
        </button>
      </div>

      <article className="mt-6 whitespace-pre-wrap text-lg leading-relaxed">
        {tokens.map((t, i) => {
          if (t.isSpace || t.lemmaId == null) {
            return <span key={i}>{t.surface}</span>;
          }
          if (isName(t.pos)) {
            const label = nameLabel(t.surface, t.lemma ?? "", t.tags);
            if (!label) return <span key={i}>{t.surface}</span>;
            return (
              <span
                key={i}
                onClick={() => setSelected(t)}
                className="cursor-pointer rounded hover:bg-gray-200"
              >
                {t.surface}
              </span>
            );
          }
          const f = flagsOf(t);
          const cls = !isUnknown(t)
            ? "hover:bg-gray-200"
            : f.stillLearning
              ? "bg-orange-200 hover:bg-orange-300" // explicit "still learning"
              : "bg-yellow-200 hover:bg-yellow-300"; // never-touched unknown
          // Dotted underline marks tokens covered by a detected MWE.
          const mweCls = mweAt.has(t.position)
            ? " underline decoration-dotted decoration-blue-400 underline-offset-4"
            : "";
          return (
            <span
              key={i}
              onClick={() => setSelected(t)}
              className={`cursor-pointer rounded ${cls}${mweCls}`}
            >
              {t.surface}
            </span>
          );
        })}
      </article>

      {!checking ? (
        <button
          type="button"
          onClick={() => setChecking(true)}
          className="mt-8 rounded border border-gray-300 px-3 py-1.5 text-sm"
        >
          Verifica comprensione
        </button>
      ) : (
        <ComprehensionCheck textId={text.id} onGraded={story ? markRead : undefined} />
      )}

      {story && !readResult && !text.readAt && (
        <button
          type="button"
          onClick={markRead}
          className="mt-4 block rounded bg-blue-600 px-4 py-2 font-medium text-white"
        >
          Segna come letto
        </button>
      )}
      {readResult && <p className="mt-4 font-medium text-green-700">{readResult.line}</p>}
      {readResult?.storyFinished && (
        <div className="mt-6 rounded border border-green-500 bg-green-50 p-4">
          <p className="text-lg font-bold">Storia completata! 🎉</p>
          <Link to="/story" className="mt-2 inline-block text-blue-600 underline">
            Scegli la prossima storia →
          </Link>
          {readResult.dayCompleted && (
            <Link to="/recap" className="ml-4 inline-block text-blue-600 underline">
              Giornata completa: riepilogo →
            </Link>
          )}
        </div>
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
              surface: occ
                ? tokens
                    .filter((t) => t.position >= occ.startPosition && t.position <= occ.endPosition)
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
          onGraded={markGraded}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
