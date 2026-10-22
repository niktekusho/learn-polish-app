import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, test } from "vitest";
import * as schema from "#/db/schema";
import { clearDictionary } from "#/maintenance/ops";
import { KAIKKI_URL, readDictVersion, updateDictionary } from "./import-job";
import { entriesForPos } from "./service";

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "drizzle" });
  return db;
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dict-update-"));
}

function dump(...words: string[]) {
  const lines = words.map((word) =>
    JSON.stringify({ word, pos: "noun", lang_code: "pl", senses: [{ glosses: ["thing"] }] }),
  );
  return gzipSync(`${lines.join("\n")}\n`);
}

const LAST_MODIFIED = "Wed, 21 Oct 2026 13:35:15 GMT";

// Answers 304 when the request carries the current ETag, like kaikki's nginx.
function kaikki(body: Buffer, etag = '"v1"', contentLength = body.length): typeof fetch {
  return async (_url, init) => {
    if (new Headers(init?.headers).get("if-none-match") === etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(new Uint8Array(body), {
      headers: {
        "content-length": String(contentLength),
        etag,
        "last-modified": LAST_MODIFIED,
      },
    });
  };
}

test("a first update downloads the dump, imports it and keeps its version", async () => {
  const db = freshDb();
  const dir = tempDir();

  const status = await updateDictionary(db, dir, kaikki(dump("zamek", "kot")));

  expect(status).toMatchObject({ state: "done", importedEntries: 2, error: null });
  expect(entriesForPos(db, "zamek", ["noun"])).toHaveLength(1);
  expect(readDictVersion(dir)).toEqual({ etag: '"v1"', lastModified: LAST_MODIFIED });
});

test("an unchanged dump is not imported again while the dictionary is loaded", async () => {
  const db = freshDb();
  const dir = tempDir();
  const fetchFn = kaikki(dump("zamek"));
  await updateDictionary(db, dir, fetchFn);

  const status = await updateDictionary(db, dir, fetchFn);

  expect(status).toMatchObject({ state: "done", upToDate: true, importedEntries: 0 });
  expect(entriesForPos(db, "zamek", ["noun"])).toHaveLength(1);
});

test("an unchanged dump is imported from the kept copy after the dictionary was wiped", async () => {
  const db = freshDb();
  const dir = tempDir();
  const fetchFn = kaikki(dump("zamek"));
  await updateDictionary(db, dir, fetchFn);
  clearDictionary(db);

  const status = await updateDictionary(db, dir, fetchFn);

  expect(status).toMatchObject({ state: "done", upToDate: false, importedEntries: 1 });
  expect(entriesForPos(db, "zamek", ["noun"])).toHaveLength(1);
});

test("an HTTP error names the URL and leaves the dictionary and kept copy as they were", async () => {
  const db = freshDb();
  const dir = tempDir();
  await updateDictionary(db, dir, kaikki(dump("zamek")));

  const status = await updateDictionary(db, dir, async () => new Response(null, { status: 404 }));

  expect(status.state).toBe("error");
  expect(status.error).toContain(KAIKKI_URL);
  expect(entriesForPos(db, "zamek", ["noun"])).toHaveLength(1);
  expect(readDictVersion(dir)?.etag).toBe('"v1"');
});

test("a download cut short leaves the dictionary and kept copy as they were", async () => {
  const db = freshDb();
  const dir = tempDir();
  await updateDictionary(db, dir, kaikki(dump("zamek")));
  const newer = dump("kot");

  const status = await updateDictionary(db, dir, kaikki(newer, '"v2"', newer.length + 100));

  expect(status.state).toBe("error");
  expect(status.error).toContain(KAIKKI_URL);
  expect(status.error).toMatch(/cut short/);
  expect(entriesForPos(db, "zamek", ["noun"])).toHaveLength(1);
  expect(entriesForPos(db, "kot", ["noun"])).toHaveLength(0);
  expect(readDictVersion(dir)?.etag).toBe('"v1"');
  expect(fs.readdirSync(dir).sort()).toEqual(["kaikki-polish.json", "kaikki-polish.jsonl.gz"]);
});

test("an import that fails is redone by the next update even though the dump is unchanged", async () => {
  const db = freshDb();
  const dir = tempDir();
  const corrupt = dump("zamek", "kot").subarray(0, 30);
  await updateDictionary(db, dir, kaikki(corrupt));

  const status = await updateDictionary(db, dir, kaikki(dump("zamek", "kot")));

  expect(status).toMatchObject({ state: "done", upToDate: false, importedEntries: 2 });
});
