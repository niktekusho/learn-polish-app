import { Link, createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  ArrowRight,
  ChevronRight,
  CircleUserRound,
  Ellipsis,
  FilePlus,
  Flame,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type { Track } from "#/fsrs/index";
import { BTN_PRIMARY, BTN_QUIET, ICON_BUTTON, LABEL_TYPE, TRACK, Tick, streakDays } from "#/ui";
import { plural } from "#/plural";

// Imported texts, newest first, with their word counts (punctuation has no lemma).
const listTexts = createServerFn().handler(async () => {
  const { db, schema } = await import("#/db/index");
  const { count, desc, eq } = await import("drizzle-orm");
  return db
    .select({
      id: schema.sourceText.id,
      title: schema.sourceText.title,
      createdAt: schema.sourceText.createdAt,
      words: count(schema.token.lemmaId),
    })
    .from(schema.sourceText)
    .leftJoin(schema.token, eq(schema.token.textId, schema.sourceText.id))
    .groupBy(schema.sourceText.id)
    .orderBy(desc(schema.sourceText.createdAt))
    .all();
});

// Reads only: a missing episode is not generated here.
const getToday = createServerFn().handler(async () => {
  const { db } = await import("#/db/index");
  const { getRecap } = await import("#/recap/service");
  const { trackCounts } = await import("#/fsrs/index");
  const { appStoryService } = await import("#/story/server");
  const story = appStoryService().activeStory();
  return {
    recap: getRecap(db),
    tracks: trackCounts(db),
    episode: story && {
      title: story.title,
      number: story.nextEpisode,
      total: story.totalEpisodes,
    },
  };
});

export const Route = createFileRoute("/")({
  component: Home,
  loader: async () => {
    const [texts, today] = await Promise.all([listTexts(), getToday()]);
    return { texts, today };
  },
});

const SECTION_HEAD = `${LABEL_TYPE} text-ink-2`;
const CARD = "rounded-lg bg-card shadow-card";

function Home() {
  const { texts, today } = Route.useLoaderData();
  const { recap, tracks, episode } = today;
  const [menu, setMenu] = useState(false);
  return (
    <div className="min-h-dvh bg-paper font-sans text-base text-ink">
      <header
        onKeyDown={(e) => e.key === "Escape" && setMenu(false)}
        className="relative mx-auto flex max-w-[1100px] items-center justify-between gap-2 pt-5 pr-2 pb-1 pl-5 sm:pt-3 sm:pl-6 lg:pt-8"
      >
        <h1 className="font-serif text-2xl font-bold tracking-[-0.01em] sm:text-xl lg:text-2xl">
          Impara il polacco
        </h1>
        <button
          type="button"
          onClick={() => setMenu(!menu)}
          aria-label="Altro"
          aria-expanded={menu}
          className={ICON_BUTTON}
        >
          <Ellipsis size={20} />
        </button>
        {menu && <div aria-hidden className="fixed inset-0 z-10" onClick={() => setMenu(false)} />}
        {menu && (
          <div className="absolute top-full right-3 z-20 grid min-w-[210px] rounded bg-panel p-2 shadow-card">
            <MenuLink to="/profile" icon={<CircleUserRound size={20} />} label="Il tuo profilo" />
            <MenuLink to="/import" icon={<FilePlus size={20} />} label="Importa testo" />
            <MenuLink to="/maintenance" icon={<Wrench size={20} />} label="Manutenzione" />
          </div>
        )}
      </header>

      <div className="mx-auto grid max-w-[1100px] gap-6 px-4 pt-2 pb-7 sm:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] sm:items-start sm:px-6 sm:pb-6 lg:gap-8 lg:pt-5">
        <section className={`${CARD} grid gap-1 p-4 pb-3`}>
          <div className="flex min-h-7 items-center justify-between gap-3">
            <h2 className={SECTION_HEAD}>Oggi</h2>
            <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-2 tabular-nums">
              <Flame size={18} className="text-productive" />
              {recap.streak} {streakDays(recap.streak)}
            </span>
          </div>
          <ul className="grid divide-y divide-rule">
            <Step
              to="/practice"
              name="Pratica"
              done={recap.practiceDone}
              next={!recap.practiceDone}
              go="Inizia"
            >
              <p className="mt-2 ml-11 text-xs text-ink-3">Da ripassare</p>
              <div className="mt-1 mb-1 ml-11 grid grid-cols-3 gap-2">
                {(Object.keys(TRACK) as Track[]).map((t) => (
                  <TrackCount key={t} track={t} {...tracks[t]} />
                ))}
              </div>
            </Step>
            <Step
              to="/story"
              name="Episodio"
              done={recap.episodeDone}
              next={recap.practiceDone && !recap.episodeDone}
              go="Leggi"
              sub={
                !recap.episodeDone &&
                episode && (
                  <>
                    <i className="font-serif">{episode.title}</i> · {episode.number} di{" "}
                    {episode.total}
                  </>
                )
              }
            />
          </ul>
          {recap.complete && (
            <Link
              to="/recap"
              className="flex min-h-11 items-center gap-2 border-t border-rule pt-2 font-semibold text-accent-ink"
            >
              Giornata completa: vedi il riepilogo <ArrowRight size={18} />
            </Link>
          )}
        </section>

        {/* Wide and tall: the list scrolls inside its card so a long list leaves Oggi alone (#24). */}
        <section
          className={`${CARD} grid min-w-0 gap-1 px-4 pt-4 pb-2 tall:sticky tall:top-3 tall:flex tall:max-h-[calc(100dvh-24px)] tall:flex-col tall:overflow-hidden`}
        >
          <div className="flex min-h-7 items-center">
            <h2 className={SECTION_HEAD}>Testi</h2>
          </div>
          {texts.length === 0 ? (
            <div className="grid justify-items-start gap-3 py-2">
              <p className="font-serif text-[16px] leading-normal text-ink-2">
                Nessun testo. Importane uno per iniziare a leggere.
              </p>
              <Link to="/import" className={BTN_QUIET}>
                <FilePlus size={18} />
                Importa un testo
              </Link>
            </div>
          ) : (
            <ul className="-mx-3 divide-y divide-rule tall:min-h-0 tall:overflow-auto tall:overscroll-contain">
              {texts.map((t) => (
                <li key={t.id}>
                  <Link
                    to="/read/$textId"
                    params={{ textId: String(t.id) }}
                    className="flex min-h-13 items-center gap-3 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 font-serif text-[16px] leading-[1.3]">
                      {t.title || `Testo #${t.id}`}
                    </span>
                    <span className="text-sm whitespace-nowrap text-ink-3 tabular-nums">
                      {t.words} {plural(t.words, "parola", "parole")}
                    </span>
                    <ChevronRight size={18} className="shrink-0 text-ink-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function MenuLink({
  to,
  icon,
  label,
}: {
  to: "/profile" | "/import" | "/maintenance";
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      to={to}
      className="flex min-h-11 items-center gap-3 rounded px-3 py-2 font-medium active:bg-accent-soft [&>svg]:text-ink-2"
    >
      {icon}
      {label}
    </Link>
  );
}

/** A daily step. The next undone one carries the screen's only primary button. */
function Step({
  to,
  name,
  done,
  next,
  go,
  sub,
  children,
}: {
  to: "/practice" | "/story";
  name: string;
  done: boolean;
  next: boolean;
  go: string;
  sub?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="py-2">
      <Link to={to} className="flex min-h-13 w-full items-center gap-3 py-1 text-left">
        {done ? <Tick /> : <span className="size-8 shrink-0 rounded-full border-2 border-rule" />}
        <span className="grid min-w-0 flex-1 gap-px">
          <b className="text-md font-semibold">{name}</b>
          {(done || sub) && (
            <small className="text-sm text-ink-3 [overflow-wrap:anywhere]">
              {done ? "Fatto" : sub}
            </small>
          )}
        </span>
        {next ? (
          <span className={BTN_PRIMARY}>
            {go}
            <ArrowRight size={18} />
          </span>
        ) : (
          <ChevronRight size={18} className="shrink-0 text-ink-3" />
        )}
      </Link>
      {children}
    </li>
  );
}

function TrackCount({ track, due, mature }: { track: Track; due: number; mature: number }) {
  const t = TRACK[track];
  return (
    <div className="grid min-w-0 gap-0.5 py-1.5">
      <span className={`flex min-w-0 items-center gap-2 text-xs font-semibold ${t.ink}`}>
        <i className={`size-[9px] shrink-0 rounded-full ${t.dot}`} />
        <span className="truncate">{t.name}</span>
      </span>
      <span className={`text-2xl font-bold tabular-nums ${t.ink}`}>{due}</span>
      <span className="text-xs text-ink-3 tabular-nums">
        {mature} {plural(mature, "consolidata", "consolidate")}
      </span>
    </div>
  );
}
