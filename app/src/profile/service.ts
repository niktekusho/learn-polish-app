import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "#/db/schema";
import { learnerProfile } from "#/db/schema";

type DB = BetterSQLite3Database<typeof schema>;

/** The Learner profile (CONTEXT.md), in Italian. An empty string is an unanswered field. */
export interface LearnerProfile {
  name: string;
  job: string;
  city: string;
  partner: string;
  hobbies: string;
}

const FIELDS = {
  name: learnerProfile.name,
  job: learnerProfile.job,
  city: learnerProfile.city,
  partner: learnerProfile.partner,
  hobbies: learnerProfile.hobbies,
};

export function getLearnerProfile(db: DB): LearnerProfile | null {
  return db.select(FIELDS).from(learnerProfile).get() ?? null;
}

/** A Conversation asks for the profile first when this is false. */
export function hasLearnerProfile(db: DB): boolean {
  return getLearnerProfile(db) !== null;
}

/** Creates the one profile or replaces it. */
export function saveLearnerProfile(db: DB, profile: LearnerProfile): void {
  const values = {
    name: profile.name.trim(),
    job: profile.job.trim(),
    city: profile.city.trim(),
    partner: profile.partner.trim(),
    hobbies: profile.hobbies.trim(),
    updatedAt: new Date(),
  };
  db.insert(learnerProfile)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: learnerProfile.id, set: values })
    .run();
}
