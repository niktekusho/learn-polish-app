import { Flag } from "lucide-react";
import { useId, useState } from "react";
import { BTN_PRIMARY, BTN_QUIET, ICON_BUTTON } from "#/ui";

/**
 * Segnala (CONTEXT.md "Report"): a flag that opens an optional note for the
 * Report review. `popover` places the form against the nearest positioned parent.
 */
export function ReportButton({
  busy,
  hint,
  popover,
  onReport,
}: {
  busy: boolean;
  hint: string;
  popover: string;
  onReport: (note: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const noteId = useId();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={busy}
        aria-label="Segnala"
        aria-expanded={open}
        className={ICON_BUTTON}
      >
        <Flag size={20} />
      </button>
      {open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onReport(note);
          }}
          className={`${popover} z-20 grid w-[min(300px,calc(100%-16px))] gap-2 rounded bg-panel p-3 shadow-card`}
        >
          <label htmlFor={noteId} className="text-sm font-semibold text-ink-2">
            Cosa non va? <span className="font-normal text-ink-3">(facoltativo)</span>
          </label>
          <textarea
            id={noteId}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            rows={3}
            autoFocus
            placeholder="Es. significato sbagliato, serve il contesto, è un nome"
            className="rounded border-[1.5px] border-rule bg-panel px-3 py-2 font-serif text-base"
          />
          <p className="text-sm text-ink-3">{hint}</p>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={BTN_QUIET}>
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
