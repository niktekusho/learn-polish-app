import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeft, Check } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import type { LearnerProfile } from "#/profile/service";
import { BTN_PRIMARY, ERROR_LINE, ICON_BUTTON, LABEL_TYPE } from "#/ui";

const getProfileFn = createServerFn().handler(async () => {
  const { db } = await import("#/db/index");
  const { getLearnerProfile } = await import("#/profile/service");
  return getLearnerProfile(db);
});

const profileInput = z.object({
  name: z.string().trim().min(1),
  job: z.string(),
  city: z.string(),
  partner: z.string(),
  hobbies: z.string(),
});

const saveProfileFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => profileInput.parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("#/db/index");
    const { saveLearnerProfile } = await import("#/profile/service");
    saveLearnerProfile(db, data);
  });

export const Route = createFileRoute("/profile")({
  // Set when the Conversation asked for the profile first: saving returns there.
  validateSearch: z.object({ next: z.literal("conversation").optional() }),
  component: ProfilePage,
  loader: () => getProfileFn(),
});

const FIELDS: { key: keyof LearnerProfile; label: string; example: string }[] = [
  { key: "name", label: "Nome", example: "Es. Marco" },
  { key: "job", label: "Lavoro", example: "Es. insegnante a scuola" },
  { key: "city", label: "Città", example: "Es. Verona" },
  { key: "partner", label: "Partner", example: "Es. Anna, di Cracovia" },
  { key: "hobbies", label: "Hobby", example: "Es. cucina, montagna" },
];

const INPUT =
  "min-h-11 w-full rounded border-[1.5px] border-rule bg-panel px-3 py-2 font-serif text-[16px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none";

function ProfilePage() {
  const profile = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const { next } = Route.useSearch();
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const data = Object.fromEntries(FIELDS.map((f) => [f.key, String(form.get(f.key) ?? "")]));
    setState("saving");
    try {
      await saveProfileFn({ data });
      if (next) {
        await navigate({ to: "/conversation" });
        return;
      }
      await router.invalidate();
      setState("saved");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-paper font-sans text-base text-ink">
      <header className="flex shrink-0 items-center px-1 py-1.5">
        <Link to="/" aria-label="Home" className={ICON_BUTTON}>
          <ArrowLeft size={20} />
        </Link>
      </header>
      <main className="mx-auto grid w-full max-w-[34rem] gap-6 px-4 pt-1 pb-7 sm:px-6">
        <div className="grid gap-2">
          <h1 className="font-serif text-2xl leading-[1.2] font-bold">Il tuo profilo</h1>
          <p className="font-serif text-[16px] leading-normal text-ink-2">
            Nelle conversazioni interpreti te stesso: i personaggi possono chiederti del lavoro,
            della città o del partner. Scrivi in italiano.
          </p>
        </div>
        <form
          onSubmit={onSubmit}
          onChange={() => state !== "saving" && setState("idle")}
          className="grid gap-4"
        >
          {FIELDS.map((f) => (
            <label key={f.key} className="grid gap-1">
              <span className={`text-ink-2 ${LABEL_TYPE}`}>{f.label}</span>
              <input
                name={f.key}
                type="text"
                lang="it"
                required={f.key === "name"}
                defaultValue={profile?.[f.key] ?? ""}
                placeholder={f.example}
                className={INPUT}
              />
            </label>
          ))}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-2">
            <button type="submit" disabled={state === "saving"} className={BTN_PRIMARY}>
              {state === "saving" ? "Salvo…" : "Salva"}
            </button>
            {state === "saved" && (
              <span role="status" className="flex items-center gap-2 text-sm text-ink-2">
                <Check size={18} className="text-accent" />
                Profilo salvato
              </span>
            )}
            {state === "error" && (
              <p role="alert" className={ERROR_LINE}>
                Salvataggio non riuscito. Riprova.
              </p>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
