import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeft, Check, Flame } from "lucide-react";
import type { RecapWord } from "#/recap/service";
import { BTN_PRIMARY, BTN_QUIET, ICON_BUTTON, LABEL_TYPE, TRACK, streakDays } from "#/ui";
import { plural } from "#/plural";

const getRecapFn = createServerFn().handler(async () => {
  const { db } = await import("#/db/index");
  const { getRecap } = await import("#/recap/service");
  return getRecap(db);
});

export const Route = createFileRoute("/recap")({
  component: RecapPage,
  loader: () => getRecapFn(),
});

const REVEAL = "animate-rise motion-reduce:animate-none [animation-delay:calc(var(--i)*90ms)]";
const order = (i: number) => ({ "--i": i }) as React.CSSProperties;

function RecapPage() {
  const r = Route.useLoaderData();
  const today = new Date().toLocaleDateString("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  // A day with nothing consolidated still shows its strongest words.
  const [label, words] =
    r.matured.examples.length > 0
      ? [plural(r.matured.count, "Consolidata oggi", "Consolidate oggi"), r.matured.examples]
      : ["Più solide oggi", r.stronger.examples];
  const missing = [!r.practiceDone && "la pratica", !r.episodeDone && "l'episodio"].filter(Boolean);
  const action = r.complete ? (
    <Link to="/" className={BTN_QUIET}>
      Torna alla Home
    </Link>
  ) : (
    <Link to={r.practiceDone ? "/story" : "/practice"} className={BTN_PRIMARY}>
      {r.practiceDone ? "Leggi l'episodio" : "Inizia la pratica"}
    </Link>
  );

  return (
    <div className="flex h-dvh flex-col bg-recap font-sans text-base text-ink">
      <header className="flex shrink-0 items-center px-1 py-1.5">
        <Link to="/" aria-label="Home" className={ICON_BUTTON}>
          <ArrowLeft size={20} />
        </Link>
      </header>
      <main className="min-h-0 flex-1 overflow-auto px-6 pt-1 pb-7 sm:px-8 sm:pb-6 lg:flex lg:items-center lg:px-12 lg:py-10">
        <div className="mx-auto grid w-full max-w-[34rem] gap-7 sm:max-w-[58rem] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:items-start sm:gap-x-14 sm:gap-y-6">
          <div className={`grid gap-2 ${REVEAL}`} style={order(0)}>
            <span className={`flex items-center gap-2 text-accent-ink ${LABEL_TYPE}`}>
              {r.complete && (
                <span className="inline-grid size-6 place-items-center rounded-full bg-accent-soft text-accent">
                  <Check size={14} strokeWidth={2.6} />
                </span>
              )}
              {today}
            </span>
            <h1 className="font-serif text-2xl leading-[1.2] font-normal text-balance">
              {r.complete ? "Giornata completa" : "Riepilogo di oggi"}
            </h1>
            {missing.length > 0 && (
              <p className="font-serif text-[16px] text-ink-2">
                {plural(missing.length, "Manca", "Mancano")} {missing.join(" e ")} di oggi.
              </p>
            )}
          </div>

          {words.length > 0 && (
            <div className="grid gap-3 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:self-center">
              <span className={`text-ink-2 ${LABEL_TYPE} ${REVEAL}`} style={order(1)}>
                {label}
              </span>
              <ul className="flex flex-wrap gap-x-6 gap-y-2.5" lang="pl">
                {words.map((w, i) => (
                  <Word key={w.lemma} word={w} i={i + 2} />
                ))}
              </ul>
            </div>
          )}

          <div className={`grid gap-5 ${REVEAL}`} style={order(7)}>
            <div className="grid grid-cols-4 gap-2 border-t border-rule pt-4">
              <Stat n={r.newWords} what={plural(r.newWords, "parola nuova", "parole nuove")} />
              <Stat
                n={r.stronger.count}
                what={plural(r.stronger.count, "più solida", "più solide")}
              />
              <Stat
                n={r.matured.count}
                what={plural(r.matured.count, "consolidata", "consolidate")}
              />
              <Stat
                n={r.streak}
                what={streakDays(r.streak)}
                icon={<Flame size={18} className="text-productive" />}
              />
            </div>
            <div className="hidden justify-items-start sm:grid">{action}</div>
          </div>
        </div>
      </main>
      {/* Narrow: the action docks at the bottom, in thumb reach. */}
      <div className="grid shrink-0 border-t border-rule px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] sm:hidden">
        {action}
      </div>
    </div>
  );
}

function Word({ word, i }: { word: RecapWord; i: number }) {
  return (
    <li className={`grid ${REVEAL}`} style={order(i)}>
      <b
        className="font-serif text-[40px] leading-[1.1] font-semibold lg:text-[52px]"
        style={{ textShadow: `0 0 26px ${TRACK[word.track].glow}` }}
      >
        {word.lemma}
      </b>
      {word.italian && (
        <em lang="it" className="font-serif text-[15px] leading-[1.3] text-ink-2">
          {word.italian}
        </em>
      )}
    </li>
  );
}

function Stat({ n, what, icon }: { n: number; what: string; icon?: React.ReactNode }) {
  return (
    <div className="grid content-start gap-0.5">
      <span className="flex items-center gap-1 text-xl font-semibold tabular-nums">
        {icon}
        {n}
      </span>
      <span className="text-xs leading-[1.3] text-ink-2">{what}</span>
    </div>
  );
}
