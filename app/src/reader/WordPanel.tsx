import { createServerFn } from "@tanstack/react-start";
import { Check, ChevronRight, ExternalLink, Pencil, RefreshCw, Volume2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";
import { z } from "zod";
import { speak } from "#/audio/speak";
import type { DictLookupResult } from "#/dictionary/service";
import type { GlossResult } from "#/gloss/service";
import { type CaseKey, caseOfForm, italianTags, posLabel } from "./labels";
import { nameForm } from "./name";
import type { KnowledgeFlags, ReaderToken } from "./types";
import {
  BTN_PRIMARY,
  BTN_QUIET,
  ERROR_LINE,
  ICON_BUTTON,
  LABEL,
  LABEL_TYPE,
  RETRY,
  TOOL,
} from "./ui";

// Server-only: resolve (and cache) the Italian gloss for a lemma. The reader
// always has a sentence, so this path may generate.
const lookupGloss = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        lemmaId: z.number().int(),
        lemma: z.string(),
        pos: z.string(),
        sentence: z.string().min(1),
        token: z.object({ id: z.number().int(), surface: z.string() }),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { getGloss } = await import("#/gloss/service");
    return getGloss(db, data);
  });

// Server-only: discard the lemma's cached glosses, occurrence glosses included,
// and generate fresh ones from context.
const regenerateGlossFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        lemmaId: z.number().int(),
        lemma: z.string(),
        pos: z.string(),
        sentence: z.string().min(1),
        token: z.object({ id: z.number().int(), surface: z.string() }),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { regenerateGloss } = await import("#/gloss/service");
    return regenerateGloss(db, data);
  });

// Server-only: save a learner-written gloss (provider 'manual').
const saveGlossFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z.object({ lemmaId: z.number().int(), italian: z.string().trim().min(1) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { setManualGloss } = await import("#/gloss/service");
    return { italian: setManualGloss(db, data.lemmaId, data.italian) };
  });

// Server-only: grade the receptive track, return the server's fresh verdict.
const markLemma = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        lemmaId: z.number().int(),
        rating: z.number().int().min(1).max(4),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<KnowledgeFlags> => {
    const { db } = await import("#/db/index");
    const { gradeLemma } = await import("#/fsrs/index");
    const { knowledgeFlags } = await import("#/reader/knowledge");
    const next = gradeLemma(db, data.lemmaId, "receptive", data.rating as 1 | 2 | 3 | 4);
    return knowledgeFlags(next.state);
  });

// Server-only: home-dictionary reference for the lemma (senses, IPA, forms,
// etymology). Read-only, no LLM involved.
const lookupDictFn = createServerFn({ method: "POST" })
  .validator((d: unknown) =>
    z
      .object({
        lemma: z.string().min(1),
        pos: z.string(),
        lemmaId: z.number().int().nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<DictLookupResult> => {
    const { db } = await import("#/db/index");
    const { lookupDictionary } = await import("#/dictionary/service");
    return lookupDictionary(db, data.lemma, data.pos, data.lemmaId ?? undefined);
  });

// Server-only: mark an MWE never-detect (CONTEXT.md "Suppressed MWE").
const suppressMweFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ lemmaId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { suppressMwe } = await import("#/dictionary/mwe-check");
    suppressMwe(db, data.lemmaId);
  });

// Server-only: mark a formula never-detect (CONTEXT.md "Suppressed formula").
const suppressFormulaFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => z.object({ lemmaId: z.number().int() }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { suppressFormula } = await import("#/dictionary/formula");
    suppressFormula(db, data.lemmaId);
  });

// ts-fsrs Rating values used by the two learner actions.
const RATING_KNOWN = 4; // Easy: long interval, marks the word learned
const RATING_LEARNING = 1; // Again: short interval, keep it in rotation

export function WordPanel({
  token,
  sentence,
  mwe = null,
  onSelectMwe,
  onSuppressed,
  onPromoted,
  onGraded,
  onClose,
}: {
  token: ReaderToken;
  sentence: string;
  // Set when the clicked token sits inside a detected MWE occurrence.
  mwe?: { lemmaId: number; headword: string } | null;
  onSelectMwe?: (mwe: { lemmaId: number; headword: string }) => void;
  onSuppressed?: () => void;
  // The clicked token moved to a new Formula unit.
  onPromoted?: (formula: { lemmaId: number; lemma: string; pos: string }) => void;
  onGraded: (lemmaId: number, flags: KnowledgeFlags) => void;
  onClose: () => void;
}) {
  const [gloss, setGloss] = useState<string | null>(null);
  const [occurrence, setOccurrence] = useState<string | null>(null);
  const [occurrenceError, setOccurrenceError] = useState<string | null>(null);
  const [suppressError, setSuppressError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [marking, setMarking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false); // the gloss shown is the learner's own
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false); // save/regenerate in flight
  const [dict, setDict] = useState<DictLookupResult | null>(null);
  const editId = useId();

  // In the reader the sentence is always present, so lookupGloss either resolves
  // with a gloss or rejects (provider/CLI failure) — a rejection is a real error,
  // not "no translation". Shared by the mount effect and the Retry button.
  const runLookup = useCallback(() => {
    if (token.lemmaId == null || token.lemma == null) return () => {};
    let alive = true;
    setLoading(true);
    setError(false);
    setGloss(null);
    setSaved(false);
    lookupGloss({
      data: {
        lemmaId: token.lemmaId,
        lemma: token.lemma,
        pos: token.pos ?? "",
        sentence,
        token: { id: token.id, surface: token.surface },
      },
    })
      .then((r) => {
        if (!alive) return;
        showGloss(r);
        if (r.formula) onPromoted?.(r.formula);
      })
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.id, token.lemmaId, token.lemma, token.pos, token.surface, sentence]);

  function showGloss(r: GlossResult) {
    setGloss(r.italian);
    setOccurrence(r.occurrence);
    setOccurrenceError(r.occurrenceError ?? null);
  }

  useEffect(() => runLookup(), [runLookup]);

  // Dictionary reference: fetch on lemma change and again when the gloss
  // settles (the hybrid path may have just written per-sense Italian rows).
  useEffect(() => {
    if (token.lemma == null) return;
    let alive = true;
    lookupDictFn({
      data: {
        lemma: token.lemma,
        pos: token.pos ?? "",
        lemmaId: token.lemmaId,
      },
    })
      .then((r) => alive && setDict(r))
      .catch(() => {}); // reference data only; panel just omits the section
    return () => {
      alive = false;
    };
  }, [token.lemma, token.pos, token.lemmaId, gloss]);

  async function regenerate() {
    if (token.lemmaId == null || token.lemma == null) return;
    setBusy(true);
    setError(false);
    try {
      const r = await regenerateGlossFn({
        data: {
          lemmaId: token.lemmaId,
          lemma: token.lemma,
          pos: token.pos ?? "",
          sentence,
          token: { id: token.id, surface: token.surface },
        },
      });
      showGloss(r);
      setSaved(false);
      if (r.formula) onPromoted?.(r.formula);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function saveGloss() {
    if (token.lemmaId == null || !draft.trim()) return;
    setBusy(true);
    try {
      const r = await saveGlossFn({
        data: { lemmaId: token.lemmaId, italian: draft },
      });
      setGloss(r.italian);
      setSaved(true);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  async function mark(rating: number) {
    if (token.lemmaId == null) return;
    setMarking(true);
    try {
      const flags = await markLemma({ data: { lemmaId: token.lemmaId, rating } });
      onGraded(token.lemmaId, flags);
      // On a phone the panel covers the text: closing is the only visible confirmation.
      onClose();
    } finally {
      setMarking(false);
    }
  }

  async function suppress(fn: typeof suppressMweFn, question: string) {
    if (token.lemmaId == null || !window.confirm(question)) return;
    setMarking(true);
    setSuppressError(null);
    try {
      await fn({ data: { lemmaId: token.lemmaId } });
      onSuppressed?.();
    } catch (err) {
      setSuppressError(err instanceof Error ? err.message : "Non riuscito.");
    } finally {
      setMarking(false);
    }
  }

  const wiktionary = token.lemma
    ? `https://en.wiktionary.org/wiki/${encodeURIComponent(token.lemma)}#Polish`
    : null;
  const ipa = dict?.entries[0]?.ipa;
  const settled = !loading && !busy && !error;
  const transLabel =
    editing || (saved && !occurrence)
      ? "Traduzione tua"
      : settled && occurrence
        ? "In questa frase"
        : "Traduzione";

  return (
    <PanelShell
      label="Parola"
      onClose={onClose}
      title={
        <>
          <b lang="pl" className="font-serif text-2xl font-bold">
            {token.surface}
          </b>
          {ipa && <span className="ml-2 text-sm whitespace-nowrap text-ink-3">{ipa}</span>}
        </>
      }
      footer={
        <>
          <button
            type="button"
            disabled={marking}
            onClick={() => mark(RATING_KNOWN)}
            className={BTN_PRIMARY}
          >
            <Check size={20} />
            La conosco
          </button>
          <button
            type="button"
            disabled={marking}
            onClick={() => mark(RATING_LEARNING)}
            className={BTN_QUIET}
          >
            Da imparare
          </button>
        </>
      }
    >
      {typeof speechSynthesis !== "undefined" && (
        <div className="mt-2.5 mb-1 flex flex-wrap gap-2">
          <button type="button" onClick={() => speak(token.surface)} className={CHIP}>
            <Volume2 size={17} />
            Ascolta
          </button>
          <button type="button" onClick={() => speak(sentence)} className={CHIP}>
            <Volume2 size={17} />
            Frase
          </button>
        </div>
      )}

      <dl className="mt-3 grid gap-2.5">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <dt className={LABEL}>Forma base</dt>
            <dd lang="pl" className="mt-0.5 font-serif text-[18px] font-semibold">
              {token.lemma}
            </dd>
          </div>
          <div>
            <dt className={LABEL}>Categoria grammaticale</dt>
            <dd className="mt-0.5">{posLabel(token.pos ?? "")}</dd>
          </div>
        </div>
        <div className="rounded bg-accent-soft px-3.5 py-3">
          <dt className={`${LABEL_TYPE} text-accent-ink`}>
            {editing ? <label htmlFor={editId}>{transLabel}</label> : transLabel}
          </dt>
          <dd className="mt-0.5">
            {loading || busy ? (
              <>
                <div className="mt-2 mb-1 grid animate-pulse gap-2 motion-reduce:animate-none">
                  <i className="block h-3 w-[55%] rounded-full bg-accent/20" />
                  <i className="block h-3 w-[35%] rounded-full bg-accent/20" />
                </div>
                <p className="mt-1.5 text-sm text-accent-ink">Traduco nel contesto della frase…</p>
              </>
            ) : error ? (
              <p className={ERROR_LINE}>
                Traduzione non riuscita.
                <button type="button" onClick={runLookup} className={RETRY}>
                  Riprova
                </button>
              </p>
            ) : editing ? (
              <div className="mt-1.5 grid gap-2">
                <input
                  id={editId}
                  type="text"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveGloss();
                    if (e.key === "Escape") setEditing(false);
                  }}
                  className="min-h-11 rounded border-[1.5px] border-accent bg-panel px-3 py-2 font-serif text-[18px] font-semibold"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveGloss}
                    disabled={!draft.trim()}
                    className={BTN_PRIMARY}
                  >
                    Salva
                  </button>
                  <button type="button" onClick={() => setEditing(false)} className={BTN_QUIET}>
                    Annulla
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="font-serif text-lg font-semibold">{occurrence ?? gloss ?? "—"}</div>
                {occurrence && gloss && occurrence !== gloss && (
                  <div className="mt-0.5 font-serif text-ink-2">
                    <span className="font-sans text-xs font-medium text-ink-3">Forma base: </span>
                    {gloss}
                  </div>
                )}
                {occurrenceError && (
                  <p className={`${ERROR_LINE} mt-1`} title={occurrenceError}>
                    Il significato in questa frase non è disponibile.
                    <button type="button" onClick={runLookup} className={RETRY}>
                      Riprova
                    </button>
                  </p>
                )}
                {token.lemmaId != null && (
                  <div className="mt-1.5 -ml-2 flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(gloss ?? "");
                        setEditing(true);
                      }}
                      className={TOOL}
                    >
                      <Pencil size={15} />
                      Modifica
                    </button>
                    <button type="button" onClick={regenerate} className={TOOL}>
                      <RefreshCw size={15} />
                      Rigenera
                    </button>
                  </div>
                )}
              </>
            )}
          </dd>
        </div>
      </dl>

      {mwe && (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
          Parte di:
          <button
            type="button"
            lang="pl"
            onClick={() => onSelectMwe?.(mwe)}
            className="min-h-11 font-serif text-md font-semibold text-accent-ink underline decoration-word-mwe decoration-dotted decoration-2 underline-offset-[0.3em]"
          >
            {mwe.headword}
          </button>
        </p>
      )}

      {token.pos === "MWE" && token.lemmaId != null && (
        <button
          type="button"
          disabled={marking}
          onClick={() =>
            suppress(
              suppressMweFn,
              `«${token.lemma}» non verrà più riconosciuta come espressione. Puoi ripristinarla da Manutenzione.`,
            )
          }
          className={SUPPRESS}
        >
          Non è un'espressione
        </button>
      )}

      {token.pos === "INTJ" && token.lemmaId != null && (
        <button
          type="button"
          disabled={marking}
          onClick={() =>
            suppress(
              suppressFormulaFn,
              `«${token.lemma}» non verrà più riconosciuta come formula: torna al verbo.`,
            )
          }
          className={SUPPRESS}
        >
          Non è una formula
        </button>
      )}
      {suppressError && <p className={ERROR_LINE}>{suppressError}</p>}

      {dict && dict.matchedBy !== null && <DictSection dict={dict} surface={token.surface} />}

      {wiktionary && (
        <a
          href={wiktionary}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-accent-ink"
        >
          Wiktionary
          <ExternalLink size={16} />
        </a>
      )}
    </PanelShell>
  );
}

const CHIP =
  "inline-flex min-h-11 items-center gap-1.5 rounded-full bg-accent-soft px-3.5 py-1.5 text-sm font-semibold text-accent-ink";
const SUPPRESS = "mt-1.5 block min-h-11 text-sm text-ink-3 underline disabled:opacity-50";

/** Slim panel for an inflected Name: base form and case only (CONTEXT.md "Name"). */
export function NamePanel({ token, onClose }: { token: ReaderToken; onClose: () => void }) {
  const name = nameForm(token.surface, token.lemma ?? "", token.tags);
  if (!name) return null;
  return (
    <PanelShell
      label="Nome proprio"
      onClose={onClose}
      title={
        <b lang="pl" className="font-serif text-2xl font-bold">
          {name.word}
        </b>
      }
    >
      <p className="mt-2 mb-1.5 font-serif text-[20px] leading-[1.35] font-semibold">
        <span lang="pl">
          {name.word} → {name.base}
        </span>
        {name.case && (
          <>
            {" "}
            <CasePill case={name.case.key} label={name.case.label} />{" "}
            <small className="font-sans text-sm font-normal text-ink-3">
              {name.number && `${name.number} `}(<span lang="pl">{name.case.polish}</span>)
            </small>
          </>
        )}
      </p>
      <p className={LABEL}>Nome proprio</p>
    </PanelShell>
  );
}

// A bottom sheet in the narrow layout; in the wide layout the Reader's side column holds it.
function PanelShell({
  label,
  title,
  footer,
  onClose,
  children,
}: {
  label: string;
  title: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="absolute inset-x-0 bottom-0 z-10 flex max-h-[80%] animate-sheet-in flex-col rounded-t-lg bg-panel font-sans text-base text-ink shadow-sheet motion-reduce:animate-none sm:static sm:max-h-none sm:min-h-0 sm:flex-1 sm:animate-none sm:rounded-none sm:bg-transparent sm:shadow-none"
    >
      <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-ink-3/30 sm:hidden" />
      <div className="min-h-0 flex-1 overflow-auto px-5 pt-1.5 pb-4.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 pt-1.5">{title}</div>
          <button type="button" onClick={onClose} aria-label="Chiudi" className={ICON_BUTTON}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
      {footer && (
        <div className="flex shrink-0 gap-2.5 border-t border-rule px-4 pt-2.5 pb-3.5 *:flex-1">
          {footer}
        </div>
      )}
    </section>
  );
}

const CASE_BG: Record<CaseKey, string> = {
  nom: "bg-case-nom",
  gen: "bg-case-gen",
  dat: "bg-case-dat",
  acc: "bg-case-acc",
  ins: "bg-case-ins",
  loc: "bg-case-loc",
  voc: "bg-case-voc",
};

function CasePill({ case: key, label }: { case: CaseKey; label: string }) {
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 align-[3px] font-sans text-xs font-semibold text-white ${CASE_BG[key]}`}
    >
      {label}
    </span>
  );
}

const SENSE_PREVIEW = 5;
const DETAILS = "group border-t border-rule";
const SUMMARY =
  "flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-sm font-semibold text-ink-2 [&::-webkit-details-marker]:hidden";
const CHEVRON = "transition-transform group-open:rotate-90";

// Home-dictionary reference block: senses (+ tags), inflection forms and
// etymology per entry. Multiple entries per word are legitimate (one per
// etymology section in the dump).
function DictSection({ dict, surface }: { dict: DictLookupResult; surface: string }) {
  const [showAll, setShowAll] = useState(false);
  const here = surface.trim().toLowerCase();
  return (
    <div className="mt-4.5 border-t border-rule pt-3.5">
      <h3 className={`${LABEL} mb-1.5`}>Dizionario</h3>
      {dict.entries.map((entry) => {
        const senses = showAll ? entry.senses : entry.senses.slice(0, SENSE_PREVIEW);
        return (
          <div key={entry.id}>
            {/* On a pos-mismatched (lemma-only) match, label each entry. */}
            {dict.matchedBy === "lemma" && (
              <div className={`${LABEL} mt-2.5`}>{posLabel(entry.pos)}</div>
            )}
            <ol className="grid list-decimal gap-1.5 pl-[1.4em] font-serif text-[16px] leading-[1.45] marker:font-sans marker:text-[13px] marker:text-ink-3">
              {senses.map((s, i) => {
                const tags = italianTags(s.tags);
                return (
                  <li key={i}>
                    {s.italian && <span className="font-semibold">{s.italian} — </span>}
                    <span className="text-ink-2">{s.gloss}</span>
                    {tags && <span className="ml-1 font-sans text-xs text-ink-3">{tags}</span>}
                  </li>
                );
              })}
            </ol>
            {entry.senses.length > SENSE_PREVIEW && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="min-h-11 text-sm font-semibold text-accent-ink"
              >
                {showAll ? "mostra meno" : `mostra tutte (${entry.senses.length})`}
              </button>
            )}
            {entry.forms.length > 0 && (
              <details className={DETAILS}>
                <summary className={SUMMARY}>
                  <ChevronRight size={17} className={CHEVRON} />
                  Forme ({entry.forms.length})
                </summary>
                <ul className="mb-2 grid gap-0.5">
                  {entry.forms.map((f, i) => {
                    const { pill, rest } = caseOfForm(f.tags);
                    const isHere = f.form.toLowerCase() === here;
                    return (
                      <li
                        key={i}
                        className="flex items-center justify-between gap-2.5 py-1 text-[13px] text-ink-3"
                      >
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          {pill && <CasePill case={pill.key} label={pill.label} />}
                          {italianTags(rest)}
                        </span>
                        <span
                          lang="pl"
                          className={`font-serif text-[16px] ${isHere ? "font-bold text-accent-ink" : "font-medium text-ink"}`}
                        >
                          {f.form}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
            {entry.etymology && (
              <details className={DETAILS}>
                <summary className={SUMMARY}>
                  <ChevronRight size={17} className={CHEVRON} />
                  Etimologia
                </summary>
                <p className="mb-2 font-serif text-sm leading-normal whitespace-pre-wrap text-ink-2">
                  {entry.etymology}
                </p>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
