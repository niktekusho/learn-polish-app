import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { fakeLlm } from "#/llm/fake";
import { ScriptedSession } from "#/llm/scripted-session";
import { saveLearnerProfile } from "#/profile/service";
import { getRecap, recordActivity } from "#/recap/service";
import { conversationService } from "./service";

const day = (n: number) => new Date(2026, 10, 7 + n, 10, 0);

function setup({ clock = day(0) } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  saveLearnerProfile(db, { name: "Marco", job: "-", city: "Milano", partner: "Ola", hobbies: "" });
  const [s] = db
    .insert(schema.story)
    .values({
      title: "Kot",
      genre: "giallo",
      hook: "h",
      outline: { plot: "p", characters: ["Ala – una ragazza"], beats: ["a", "b"] },
      plannedEpisodes: 2,
      status: "active",
    })
    .returning()
    .all();
  let now = clock;
  const svc = conversationService(db, {
    llm: fakeLlm({
      answers: {
        scene: () => ({
          character: 0,
          scene: "Scena",
          steps: ["Passo"],
          roleFacts: null,
          opening: { line: "Otwarcie.", italian: "Apertura.", hint: [], modelLine: "" },
          voices: ["gosia"],
        }),
        debrief: () => ({ corrections: [], memory: [] }),
      },
    }),
    voices: async () => [{ id: "gosia", label: "Voce femminile" }],
    analyze: async () => ({ sentences: [] }),
    createSession: () => new ScriptedSession(),
    now: () => now,
  });

  /** Read Episode `n` on `at`, as the reader does: the day's Episode is recorded. */
  function readEpisode(n: number, at: Date) {
    db.insert(schema.sourceText)
      .values({ content: `Odcinek ${n}.`, storyId: s.id, episodeNumber: n, readAt: at })
      .run();
    recordActivity(db, "episode", at);
  }

  /** Play `turns` learner turns of the current Conversation on `at`, and return its id. */
  async function speak(turns: number, at: Date) {
    now = at;
    const current = await svc.current();
    const id = (current as { conversation: { id: number } }).conversation.id;
    for (let i = 0; i < turns; i++) {
      svc.addTurn(id, `Zdanie ${i + 1}.`);
      await svc.reply(id);
    }
    return id;
  }

  /** Play the current Conversation on `at` with `turns` learner turns, then reach its Debrief. */
  async function converse(turns: number, at: Date) {
    await svc.debrief(await speak(turns, at));
  }
  return { db, svc, readEpisode, speak, converse };
}

test("the day after an Episode is read, the routine's item is its Conversation", () => {
  const { db, readEpisode } = setup();
  readEpisode(1, day(0));

  expect(getRecap(db, day(0))).toMatchObject({ item: "episode", itemDone: true });
  expect(getRecap(db, day(1))).toMatchObject({
    item: "conversation",
    itemDone: false,
    complete: false,
  });
});

test("after a Conversation is debriefed, the next day's item is the next Episode", async () => {
  const { db, readEpisode, converse } = setup();
  readEpisode(1, day(0));
  await converse(3, day(1));

  expect(getRecap(db, day(1))).toMatchObject({ item: "conversation", itemDone: true });
  expect(getRecap(db, day(2))).toMatchObject({ item: "episode", itemDone: false });
});

test("a Debrief reached with 3 learner turns records the day's Conversation, Goal unmet", async () => {
  const { db, readEpisode, converse } = setup();
  readEpisode(1, day(0));
  recordActivity(db, "practice", day(1));
  await converse(3, day(1));

  expect(getRecap(db, day(1))).toMatchObject({ itemDone: true, complete: true });
});

test("a Debrief reached with 2 learner turns does not record the day's Conversation", async () => {
  const { db, readEpisode, converse } = setup();
  readEpisode(1, day(0));
  recordActivity(db, "practice", day(1));
  await converse(2, day(1));

  expect(getRecap(db, day(1))).toMatchObject({
    item: "conversation",
    itemDone: false,
    complete: false,
    conversation: null,
  });
  expect(getRecap(db, day(2))).toMatchObject({ item: "episode" });
});

test("a Conversation left mid-scene stays current after a newer Episode is read", async () => {
  const { db, svc, readEpisode, speak } = setup();
  readEpisode(1, day(0));
  const id = await speak(1, day(1));
  readEpisode(2, day(1));

  expect(getRecap(db, day(2))).toMatchObject({ item: "conversation" });
  const current = await svc.current();
  expect(current).toMatchObject({ conversation: { id } });
});

test("a no-mic day with Practice alone keeps the Streak, and the Conversation waits", () => {
  const { db, readEpisode } = setup();
  readEpisode(1, day(0));
  recordActivity(db, "practice", day(1));

  expect(getRecap(db, day(1))).toMatchObject({
    streak: 2,
    item: "conversation",
    complete: false,
  });
  expect(getRecap(db, day(2))).toMatchObject({ streak: 2, item: "conversation" });
});
