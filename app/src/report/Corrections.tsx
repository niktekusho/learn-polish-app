import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";
import type { Correction } from "./review";

const undoReviewFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ reviewId: z.number().int(), note: z.string().max(500) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { undoReview } = await import("./review");
    undoReview(db, data.reviewId, data.note);
  });

/** Report reviews and Lemma slip repairs, one line each, with Annulla on reviews. */
export function Corrections({
  title,
  items,
  className,
}: {
  title: string;
  items: Correction[];
  className?: string;
}) {
  const [list, setList] = useState(items);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (list.length === 0) return null;

  async function undo(c: Correction) {
    let note = "";
    if (!c.changed) {
      const input = window.prompt(
        "Cosa non va? (facoltativo)\nLa parola esce dalla pratica fino alla prossima revisione.",
      );
      if (input === null) return;
      note = input;
    }
    setBusy(true);
    setError(null);
    try {
      await undoReviewFn({ data: { reviewId: c.reviewId!, note } });
      setList((prev) => prev.map((x) => (x === c ? { ...x, undone: true, undoable: false } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Annulla non riuscito.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`rounded border border-gray-200 p-4 ${className ?? ""}`}>
      <h2 className="font-semibold">{title}</h2>
      <ul className="mt-2 divide-y divide-gray-100 text-sm">
        {list.map((c, i) => (
          <li key={i} className="flex items-start justify-between gap-3 py-1.5">
            <div>
              <div>
                {c.line}
                {c.undone && <span className="text-gray-500"> (annullata)</span>}
              </div>
              {c.reason && <div className="text-gray-500">{c.reason}</div>}
            </div>
            {c.reviewId !== null && (
              <button
                type="button"
                onClick={() => undo(c)}
                disabled={busy || !c.undoable}
                className="shrink-0 rounded border border-gray-300 px-3 py-1 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Annulla
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
