import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pipeline, Readable } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "#/db/schema";
import { getStats, relinkDerivedWords, repairLemmaSlips } from "#/maintenance/ops";
import { insertEntryBatch, wipeDictionary } from "./loader";
import { type ParsedEntry, parseKaikkiLine } from "./parse";

type DB = BetterSQLite3Database<typeof schema>;

// A Vite HMR reload mid-update would orphan the job's status: it lives on globalThis.
// One job at a time (ADR-0002), polled by the maintenance page.

export const KAIKKI_URL =
  "https://kaikki.org/dictionary/Polish/kaikki.org-dictionary-Polish.jsonl.gz";
const DUMP_FILE = "kaikki-polish.jsonl.gz";
// Present only once the dictionary holds that dump: a failed import leaves none, so the
// next update downloads again instead of answering 304 over a half-loaded dictionary.
const VERSION_FILE = "kaikki-polish.json";
// ponytail: whole-request timeout, needs ~150 KB/s for the 89 MB dump; a stall timer if that is too slow.
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export interface DictVersion {
  etag: string | null;
  lastModified: string | null;
}

export interface DictImportStatus {
  state: "idle" | "downloading" | "importing" | "done" | "error";
  startedAt: string | null; // ISO
  finishedAt: string | null;
  // Download bytes while downloading, compressed bytes read while importing.
  totalBytes: number;
  readBytes: number;
  processedLines: number;
  importedEntries: number;
  skipped: {
    otherLang: number;
    pos: number;
    formOf: number;
    noSenses: number;
    unparsable: number;
  };
  upToDate: boolean;
  repairs: { relinkedTokens: number; slips: number } | null;
  error: string | null;
}

function freshStatus(): DictImportStatus {
  return {
    state: "idle",
    startedAt: null,
    finishedAt: null,
    totalBytes: 0,
    readBytes: 0,
    processedLines: 0,
    importedEntries: 0,
    skipped: { otherLang: 0, pos: 0, formOf: 0, noSenses: 0, unparsable: 0 },
    upToDate: false,
    repairs: null,
    error: null,
  };
}

const g = globalThis as typeof globalThis & {
  __dictImportStatus?: DictImportStatus;
};

export function getImportStatus(): DictImportStatus {
  return (g.__dictImportStatus ??= freshStatus());
}

export function readDictVersion(dir: string): DictVersion | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, VERSION_FILE), "utf8"));
  } catch {
    return null;
  }
}

const BATCH_SIZE = 500;

const SKIP_KEY = {
  "other-lang": "otherLang",
  pos: "pos",
  "form-of": "formOf",
  "no-senses": "noSenses",
  unparsable: "unparsable",
} as const;

/** Kick off the update and return immediately. Refuses if one is already running. */
export function startUpdate(db: DB, dir: string): { started: boolean; reason?: string } {
  const { state } = getImportStatus();
  if (state === "downloading" || state === "importing") {
    return { started: false, reason: "an update is already running" };
  }
  void updateDictionary(db, dir);
  return { started: true };
}

/**
 * Download the dump into `dir` unless the kept copy is current, then import it.
 * An unchanged dump is imported only when the dictionary is empty.
 */
export async function updateDictionary(
  db: DB,
  dir: string,
  fetchFn: typeof fetch = fetch,
): Promise<DictImportStatus> {
  const status = freshStatus();
  status.state = "downloading";
  status.startedAt = new Date().toISOString();
  g.__dictImportStatus = status;
  try {
    const versionPath = path.join(dir, VERSION_FILE);
    const downloaded = await download(fetchFn, dir, status);
    if (!downloaded && getStats(db).dictEntries > 0) {
      status.upToDate = true;
    } else {
      const version = downloaded ?? readDictVersion(dir);
      fs.rmSync(versionPath, { force: true });
      await runImport(db, path.join(dir, DUMP_FILE), status);
      fs.writeFileSync(versionPath, JSON.stringify(version));
      try {
        status.repairs = {
          relinkedTokens: relinkDerivedWords(db),
          slips: repairLemmaSlips(db).length,
        };
      } catch (err) {
        console.error("[slips] repair failed:", err);
      }
    }
    status.state = "done";
  } catch (err) {
    status.state = "error";
    status.error = err instanceof Error ? err.message : String(err);
  }
  status.finishedAt = new Date().toISOString();
  return status;
}

/** The downloaded dump's version, or null when kaikki answers 304 for the kept copy. */
async function download(
  fetchFn: typeof fetch,
  dir: string,
  status: DictImportStatus,
): Promise<DictVersion | null> {
  const dumpPath = path.join(dir, DUMP_FILE);
  const etag = fs.existsSync(dumpPath) ? readDictVersion(dir)?.etag : null;
  const part = `${dumpPath}.part`;
  try {
    const res = await fetchFn(KAIKKI_URL, {
      headers: etag ? { "if-none-match": etag } : {},
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (res.status === 304) return null;
    if (!res.ok || !res.body) throw new Error(`answered HTTP ${res.status}`);

    // The import wipes before it reads, so the dump must be complete on disk first.
    status.totalBytes = Number(res.headers.get("content-length") ?? 0);
    const body = Readable.fromWeb(res.body as ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      status.readBytes += chunk.length;
    });
    await pipelineAsync(body, fs.createWriteStream(part));
    if (status.totalBytes > 0 && status.readBytes !== status.totalBytes) {
      throw new Error(`cut short: ${status.readBytes} of ${status.totalBytes} bytes`);
    }
    fs.renameSync(part, dumpPath);
    return { etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified") };
  } catch (err) {
    throw new Error(`GET ${KAIKKI_URL} failed: ${err instanceof Error ? err.message : err}`);
  } finally {
    fs.rmSync(part, { force: true });
  }
}

async function runImport(db: DB, filePath: string, status: DictImportStatus): Promise<void> {
  status.state = "importing";
  status.totalBytes = fs.statSync(filePath).size;
  status.readBytes = 0;

  // Idempotent re-import: always start from an empty dictionary.
  wipeDictionary(db);

  const file = fs.createReadStream(filePath);
  // A corrupt gzip throws from the line loop below: the callback only swallows the duplicate.
  const rl = readline.createInterface({
    input: pipeline(file, createGunzip(), () => {}),
    crlfDelay: Infinity,
  });

  let batch: ParsedEntry[] = [];
  const flush = async () => {
    insertEntryBatch(db, batch);
    status.importedEntries += batch.length;
    batch = [];
    // better-sqlite3 is synchronous: without this yield the status-poll
    // server fn starves for the whole import.
    await new Promise((r) => setImmediate(r));
  };

  for await (const line of rl) {
    status.processedLines++;
    status.readBytes = file.bytesRead;
    const outcome = parseKaikkiLine(line);
    if (outcome.kind === "skip") {
      // One bad line never aborts the whole import.
      status.skipped[SKIP_KEY[outcome.reason]]++;
      continue;
    }
    batch.push(outcome.entry);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();
}
