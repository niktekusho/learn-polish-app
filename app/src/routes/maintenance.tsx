import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Volume2 } from "lucide-react";
import { useEffect, useState } from "react";
import { z } from "zod";
import { playVoice } from "#/audio/speak";
import type { DictImportStatus, DictVersion } from "#/dictionary/import-job";
import type { Voice } from "#/import/sidecar";
import type { ContextBoundLemma, MaintenanceStats } from "#/maintenance/ops";
import { Corrections } from "#/report/Corrections";
import type { Correction } from "#/report/review";

const loadStats = createServerFn().handler(async (): Promise<MaintenanceStats> => {
  const { db } = await import("#/db/index");
  const { getStats } = await import("#/maintenance/ops");
  return getStats(db);
});

const loadReviews = createServerFn().handler(async (): Promise<Correction[]> => {
  const { db } = await import("#/db/index");
  const { listReviews } = await import("#/report/review");
  return listReviews(db);
});

const loadContextBound = createServerFn().handler(async (): Promise<ContextBoundLemma[]> => {
  const { db } = await import("#/db/index");
  const { listContextBound } = await import("#/maintenance/ops");
  return listContextBound(db);
});

const unmarkContextBoundFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ lemmaId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { unmarkContextBound } = await import("#/maintenance/ops");
    unmarkContextBound(db, data.lemmaId);
  });

const loadSuppressed = createServerFn().handler(async (): Promise<ContextBoundLemma[]> => {
  const { db } = await import("#/db/index");
  const { listSuppressedMwes } = await import("#/maintenance/ops");
  return listSuppressedMwes(db);
});

const restoreMweFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ lemmaId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { restoreMwe } = await import("#/dictionary/mwe-check");
    const { getGlossProvider } = await import("#/llm/index");
    await restoreMwe(db, getGlossProvider(), data.lemmaId);
  });

const actionInput = z.object({
  action: z.enum([
    "clear-texts",
    "prune-lemmas",
    "purge-stub-glosses",
    "clear-dictionary",
    "recheck-mwes",
    "repair-names",
    "repair-character-names",
    "repair-formulas",
    "proofread-episodes",
  ]),
});

const runAction = createServerFn({ method: "POST" })
  .validator((d: unknown) => actionInput.parse(d))
  .handler(async ({ data }): Promise<{ deleted: number; note?: string }> => {
    const { db } = await import("#/db/index");
    const ops = await import("#/maintenance/ops");
    switch (data.action) {
      case "clear-texts":
        return { deleted: ops.clearSourceTexts(db) };
      case "prune-lemmas":
        return { deleted: ops.pruneOrphanLemmas(db) };
      case "purge-stub-glosses":
        return { deleted: ops.purgeStubGlosses(db) };
      case "clear-dictionary":
        return { deleted: ops.clearDictionary(db) };
      case "recheck-mwes": {
        const { recheckMwes } = await import("#/dictionary/mwe-check");
        const { getGlossProvider } = await import("#/llm/index");
        return { deleted: await recheckMwes(db, getGlossProvider()) };
      }
      case "repair-names": {
        const r = ops.repairNames(db);
        const { analyze } = await import("#/import/sidecar");
        const b = await ops.backfillTokenTags(db, analyze);
        return {
          deleted: r.deleted,
          note: `Names: ${r.merged} variants merged, ${r.commonWords} common words relinked, ${r.cleared} knowledge/gloss/review rows cleared. Morph tags: ${b.filled} texts filled, ${b.skipped} skipped (tokens differ), ${b.failed} failed (sidecar unreachable or erroring).`,
        };
      }
      case "repair-character-names": {
        const { getGlossProvider } = await import("#/llm/index");
        const r = await ops.repairCharacterNames(db, getGlossProvider());
        return {
          deleted: r.deletedLemmas,
          note: `${r.moved} occurrences moved to their character.`,
        };
      }
      case "repair-formulas": {
        const { repairFormulas } = await import("#/dictionary/formula");
        const { getGlossProvider } = await import("#/llm/index");
        const r = await repairFormulas(db, getGlossProvider());
        return { deleted: r.deletedLemmas, note: `${r.moved} occurrences moved to their formula.` };
      }
      case "proofread-episodes": {
        const { getGlossProvider } = await import("#/llm/index");
        const { analyze } = await import("#/import/sidecar");
        const provider = getGlossProvider();
        const r = await ops.proofreadEpisodes(db, { provider, analyze, checker: provider });
        const lines = [
          `${r.repaired.length} episodes corrected, ${r.failed.length} failed.`,
          ...r.repaired.flatMap((t) => t.changes.map((c) => `${t.label}: ${c}`)),
          ...r.failed.map((t) => `${t.label} failed: ${t.cause}`),
        ];
        return { deleted: r.deletedLemmas, note: lines.join("\n") };
      }
    }
  });

const startDictUpdate = createServerFn({ method: "POST" }).handler(async () => {
  const { db, DATA_DIR } = await import("#/db/index");
  const { startUpdate } = await import("#/dictionary/import-job");
  return startUpdate(db, DATA_DIR);
});

const loadDictVersion = createServerFn().handler(async (): Promise<DictVersion | null> => {
  const { DATA_DIR } = await import("#/db/index");
  const { readDictVersion } = await import("#/dictionary/import-job");
  return readDictVersion(DATA_DIR);
});

const getDictImportStatus = createServerFn().handler(async (): Promise<DictImportStatus> => {
  const { getImportStatus } = await import("#/dictionary/import-job");
  return getImportStatus();
});

// null when the sidecar is down, so the rest of the page still loads.
const loadVoices = createServerFn().handler(async (): Promise<Voice[] | null> => {
  const { voices } = await import("#/import/sidecar");
  return voices().catch(() => null);
});

export const Route = createFileRoute("/maintenance")({
  component: Maintenance,
  loader: async () => {
    const [stats, reviews, contextBound, suppressed, dictVersion, voices] = await Promise.all([
      loadStats(),
      loadReviews(),
      loadContextBound(),
      loadSuppressed(),
      loadDictVersion(),
      loadVoices(),
    ]);
    return { stats, reviews, contextBound, suppressed, dictVersion, voices };
  },
});

type Action = z.infer<typeof actionInput>["action"];

function Maintenance() {
  const { stats, reviews, contextBound, suppressed, dictVersion, voices } = Route.useLoaderData();
  const [restoring, setRestoring] = useState<number | null>(null);
  const router = useRouter();
  const [pending, setPending] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dictStatus, setDictStatus] = useState<DictImportStatus | null>(null);

  const importing = dictStatus?.state === "downloading" || dictStatus?.state === "importing";
  const progress =
    dictStatus && dictStatus.totalBytes > 0
      ? Math.round((100 * dictStatus.readBytes) / dictStatus.totalBytes)
      : 0;

  // Fetch once on mount (reattaches to a job after a page reload), then poll
  // every second while an import runs; refresh stats when it settles.
  useEffect(() => {
    let stop = false;
    getDictImportStatus().then((s) => !stop && setDictStatus(s));
    return () => {
      stop = true;
    };
  }, []);
  useEffect(() => {
    if (!importing) return;
    const id = setInterval(async () => {
      const s = await getDictImportStatus();
      setDictStatus(s);
      if (s.state !== "downloading" && s.state !== "importing") await router.invalidate();
    }, 1000);
    return () => clearInterval(id);
  }, [importing, router]);

  async function runUpdate() {
    if (
      !window.confirm(
        "Download the latest kaikki dictionary? If kaikki has a newer dump, the current dictionary is wiped and reloaded from it.",
      )
    )
      return;
    setError(null);
    setMessage(null);
    const res = await startDictUpdate();
    if (!res.started) {
      setError(res.reason ?? "Update did not start.");
      return;
    }
    setDictStatus(await getDictImportStatus());
  }

  async function run(action: Action, confirmText: string, noun: string) {
    if (!window.confirm(confirmText)) return;
    setPending(action);
    setMessage(null);
    setError(null);
    try {
      const { deleted, note } = await runAction({ data: { action } });
      setMessage(`Deleted ${deleted} ${noun}.${note ? ` ${note}` : ""}`);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Operation failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Maintenance</h1>
      <p className="mt-2 text-sm text-gray-600">
        Housekeeping for the vocab store. Glosses (translations) and FSRS progress are never touched
        by "Clear imported texts".
      </p>

      {reviews.length > 0 && (
        <div className="mt-8 rounded border border-gray-200 p-4">
          <h2 className="font-semibold">Report reviews ({reviews.length})</h2>
          <Corrections items={reviews} />
        </div>
      )}

      {contextBound.length > 0 && (
        <div className="mt-8 rounded border border-gray-200 p-4">
          <h2 className="font-semibold">Needs context ({contextBound.length})</h2>
          <p className="mt-1 text-sm text-gray-600">
            Never asked as a single word in Practice; still read aloud. Unmark to bring a word back.
          </p>
          <ul className="mt-3 divide-y divide-gray-100 text-sm">
            {contextBound.map((c) => (
              <li key={c.lemmaId} className="flex items-center justify-between py-1.5">
                <span>
                  <span className="font-semibold">{c.lemma}</span>{" "}
                  <span className="text-gray-500">{c.pos}</span>
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    await unmarkContextBoundFn({ data: { lemmaId: c.lemmaId } });
                    await router.invalidate();
                  }}
                  className="rounded border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-50"
                >
                  Unmark
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {suppressed.length > 0 && (
        <div className="mt-8 rounded border border-gray-200 p-4">
          <h2 className="font-semibold">Not expressions ({suppressed.length})</h2>
          <p className="mt-1 text-sm text-gray-600">
            Never detected as multi-word expressions. Restore finds them again in past texts and
            keeps only the matches the LLM confirms.
          </p>
          <ul className="mt-3 divide-y divide-gray-100 text-sm">
            {suppressed.map((m) => (
              <li key={m.lemmaId} className="flex items-center justify-between py-1.5">
                <span className="font-semibold">{m.lemma}</span>
                <button
                  type="button"
                  disabled={restoring !== null}
                  onClick={async () => {
                    setRestoring(m.lemmaId);
                    setError(null);
                    try {
                      await restoreMweFn({ data: { lemmaId: m.lemmaId } });
                      await router.invalidate();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Restore failed.");
                    } finally {
                      setRestoring(null);
                    }
                  }}
                  className="rounded border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                  {restoring === m.lemmaId ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
        <Stat label="Texts" value={stats.texts} />
        <Stat label="Tokens" value={stats.tokens} />
        <Stat label="Lemmas" value={stats.lemmas} />
        <Stat label="Glosses" value={stats.glosses} />
        <Stat label="Stub glosses" value={stats.stubGlosses} />
        <Stat label="Reviews" value={stats.reviews} />
        <Stat label="Dict entries" value={stats.dictEntries} />
        <Stat label="Dict senses" value={stats.dictSenses} />
        <Stat label="Dict forms" value={stats.dictForms} />
        <Stat label="Dict MWEs" value={stats.dictMwes} />
      </dl>

      <div className="mt-8 rounded border border-gray-200 p-4">
        <h2 className="font-semibold">Home dictionary</h2>
        <p className="mt-1 text-sm text-gray-600">
          The kaikki.org Polish dump (see docs/adr/0002), downloaded only when kaikki has a newer
          one. Current version:{" "}
          {dictVersion?.lastModified
            ? new Date(dictVersion.lastModified).toLocaleDateString()
            : "none downloaded"}
          .
        </p>
        <div className="mt-3">
          <button
            type="button"
            onClick={runUpdate}
            disabled={importing}
            className="rounded border border-blue-300 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
          >
            {importing ? "Updating…" : "Download latest and import"}
          </button>
        </div>
        {dictStatus && dictStatus.state !== "idle" && (
          <p className="mt-2 text-sm text-gray-600">
            {dictStatus.state === "downloading" && `Downloading — ${progress}%`}
            {dictStatus.state === "importing" &&
              `Imported ${dictStatus.importedEntries} entries — ${progress}%`}
            {dictStatus.state === "done" &&
              (dictStatus.upToDate
                ? "Up to date: kaikki has no newer dump."
                : `Done: ${dictStatus.importedEntries} entries imported (${dictStatus.processedLines} lines).${
                    dictStatus.repairs
                      ? ` ${dictStatus.repairs.slips} lemma slips repaired, ${dictStatus.repairs.relinkedTokens} tokens relinked to derived words.`
                      : ""
                  }`)}
            {dictStatus.state === "error" && (
              <span className="text-red-700">Update failed: {dictStatus.error}</span>
            )}
          </p>
        )}
      </div>

      <VoicePreview voices={voices} />

      <div className="mt-8 space-y-6">
        <ActionRow
          title="Clear imported texts"
          description="Deletes all imported texts and their tokens. Lemmas, translations, and learning progress are kept."
          button="Clear texts"
          pending={pending === "clear-texts"}
          disabled={pending !== null || stats.texts === 0}
          onClick={() =>
            run(
              "clear-texts",
              `Delete all ${stats.texts} imported texts? Translations and progress are kept.`,
              "texts",
            )
          }
        />
        <ActionRow
          title="Prune orphan lemmas"
          description="Deletes lemmas that appear in no text, have no translation, and were never practiced. Run after clearing texts to drop the untouched backlog."
          button="Prune lemmas"
          pending={pending === "prune-lemmas"}
          disabled={pending !== null}
          onClick={() =>
            run(
              "prune-lemmas",
              "Delete all lemmas with no text, no translation, and no review history?",
              "lemmas",
            )
          }
        />
        <ActionRow
          title="Purge stub glosses"
          description="Deletes translations produced by the development stub provider so the real provider can regenerate them."
          button="Purge stubs"
          pending={pending === "purge-stub-glosses"}
          disabled={pending !== null || stats.stubGlosses === 0}
          onClick={() =>
            run("purge-stub-glosses", `Delete ${stats.stubGlosses} stub glosses?`, "stub glosses")
          }
        />
        <ActionRow
          title="Recheck expressions"
          description="Asks the LLM whether each detected multi-word expression is really one in its sentence, in one call, and deletes the false matches."
          button="Recheck"
          pending={pending === "recheck-mwes"}
          disabled={pending !== null}
          onClick={() =>
            run(
              "recheck-mwes",
              "Recheck every detected expression with the LLM and delete the false matches?",
              "false expression matches",
            )
          }
        />
        <ActionRow
          title="Repair names + backfill morph tags"
          description="Names lose knowledge, glosses and reviews, variants merge, capitalized common words join their lemma (Story characters and reviewed Names excepted), emoji and fragments go. Then texts with untagged tokens are re-analyzed through the sidecar to store their morph tags."
          button="Repair + backfill"
          pending={pending === "repair-names"}
          disabled={pending !== null}
          onClick={() =>
            run(
              "repair-names",
              "Repair names and backfill morph tags? Names' knowledge, glosses and review history are deleted.",
              "emoji/fragment lemmas",
            )
          }
        />
        <ActionRow
          title="Repair Story character names"
          description="In every Episode, a capitalized form of a Story character's name becomes that Name (Iskro, Iskrę → Iskra), even when it is also a common word. At sentence start it is checked in its sentence first. A word left with no uses is deleted with its knowledge. Fails without changes if the provider cannot run the check."
          button="Repair characters"
          pending={pending === "repair-character-names"}
          disabled={pending !== null}
          onClick={() =>
            run(
              "repair-character-names",
              "Move Story character names to their Name? Words left with no uses are deleted with their knowledge.",
              "words left with no uses",
            )
          }
        />
        <ActionRow
          title="Repair formulas"
          description="Checks words like proszę or dziękuję in their sentences and moves interjection uses to their own formula, which starts with fresh knowledge. A verb left with no uses is deleted with its knowledge, reviews and glosses. Fails without changes if the provider cannot run the check."
          button="Repair formulas"
          pending={pending === "repair-formulas"}
          disabled={pending !== null}
          onClick={() =>
            run(
              "repair-formulas",
              "Repair formulas? Verbs left with no uses lose their knowledge, review history and glosses.",
              "verb lemmas left without uses",
            )
          }
        />
        <ActionRow
          title="Proofread episodes"
          description="Proofreads every story episode against the home dictionary and the LLM, and corrects the flagged ones in place: read state is kept, passage questions are re-prepared. Non-words the correction removed are deleted with their knowledge, reviews and glosses. An episode whose correction fails stays unchanged."
          button="Proofread"
          pending={pending === "proofread-episodes"}
          disabled={pending !== null}
          onClick={() =>
            run(
              "proofread-episodes",
              "Proofread and correct every episode? Non-words removed by a correction lose their knowledge, review history and glosses.",
              "non-word lemmas",
            )
          }
        />
        <ActionRow
          title="Clear dictionary"
          description="Deletes the whole home dictionary (entries, senses, forms). Download and import again to restore it."
          button="Clear dictionary"
          pending={pending === "clear-dictionary"}
          disabled={pending !== null || importing || stats.dictEntries === 0}
          onClick={() =>
            run(
              "clear-dictionary",
              `Delete all ${stats.dictEntries} dictionary entries?`,
              "dictionary entries",
            )
          }
        />
      </div>

      {message && (
        <p className="mt-6 rounded bg-green-50 p-3 text-sm whitespace-pre-line text-green-800">
          {message}
        </p>
      )}
      {error && <p className="mt-6 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between border-b border-gray-100 py-1">
      <dt className="text-gray-600">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function ActionRow(props: {
  title: string;
  description: string;
  button: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded border border-gray-200 p-4">
      <div>
        <h2 className="font-semibold">{props.title}</h2>
        <p className="mt-1 text-sm text-gray-600">{props.description}</p>
      </div>
      <button
        type="button"
        onClick={props.onClick}
        disabled={props.disabled}
        className="shrink-0 rounded border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
      >
        {props.pending ? "Working…" : props.button}
      </button>
    </div>
  );
}

function VoicePreview({ voices }: { voices: Voice[] | null }) {
  const [text, setText] = useState("Dzień dobry, poproszę dwie bułki.");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="mt-8 rounded border border-rule p-4">
      <h2 className="font-semibold">Voci</h2>
      <p className="mt-1 text-sm text-ink-2">
        Le voci dei personaggi nelle conversazioni. La prima frase in una voce richiede qualche
        secondo, poi resta in memoria.
      </p>
      {voices === null ? (
        <p className="mt-3 text-sm text-bad-ink">Il sidecar non risponde.</p>
      ) : (
        <>
          <label htmlFor="voice-text" className="mt-3 block text-sm text-ink-3">
            Frase
          </label>
          <input
            id="voice-text"
            lang="pl"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="mt-1 min-h-11 w-full rounded border border-rule bg-panel px-3 font-serif text-ink"
          />
          <ul className="mt-3 divide-y divide-rule">
            {voices.map((v) => (
              <li key={v.id} className="flex items-center justify-between gap-4 py-1.5">
                <span>
                  {v.label}
                  <span className="block text-sm text-ink-3">{v.id}</span>
                </span>
                <button
                  type="button"
                  disabled={!text.trim()}
                  onClick={() => {
                    setError(null);
                    playVoice(text, v.id).catch(() =>
                      setError(`${v.label}: audio non disponibile.`),
                    );
                  }}
                  className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-accent-soft px-4 text-sm font-semibold text-accent-ink disabled:opacity-50"
                >
                  <Volume2 size={17} /> Ascolta
                </button>
              </li>
            ))}
          </ul>
          {error && <p className="mt-2 text-sm text-bad-ink">{error}</p>}
        </>
      )}
    </div>
  );
}
