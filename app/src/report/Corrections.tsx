import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { z } from "zod";
import { BTN_QUIET, ERROR_LINE } from "#/ui";
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
export function Corrections({ items }: { items: Correction[] }) {
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
    <div>
      <ul className="divide-y divide-rule">
        {list.map((c, i) => (
          <li key={i} className="flex items-start justify-between gap-3 py-2">
            <div>
              <div className="font-serif text-base leading-[1.4]">
                {c.line}
                {c.undone && <span className="text-ink-3"> (annullata)</span>}
              </div>
              {c.reason && <div className="mt-1 font-serif text-sm text-ink-3">{c.reason}</div>}
            </div>
            {c.reviewId !== null && (
              <button
                type="button"
                onClick={() => undo(c)}
                disabled={busy || !c.undoable}
                className={`${BTN_QUIET} shrink-0 px-3 py-2 text-sm`}
              >
                Annulla
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className={`${ERROR_LINE} mt-2`}>{error}</p>}
    </div>
  );
}
