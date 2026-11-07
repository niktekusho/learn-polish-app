#!/usr/bin/env node
// Drive a page of the running dev server and screenshot it along the way:
//   node scripts/drive.mts <path> <outdir> <step>...
// Steps run in order:
//   click:<text>   click the button, link or span whose text is exactly <text> (waits up to 10s)
//   press:<css>    click the first element matching a CSS selector (waits up to 10s)
//   wait:<ms>      sleep
//   shot:<name>    save <outdir>/<name>.png
// Example: node scripts/drive.mts /conversation /tmp/shots "click:Tocca per leggere" shot:polish
// BASE_URL (default http://127.0.0.1:3000) and SIZE (default 412,860) override. Each distinct
// page console error and uncaught exception is printed once, so a broken screen shows.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";

/** A DevTools protocol message: a reply carries the id of its command, an event its method. */
interface CdpMessage {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
}

interface Pending {
  resolve: (m: CdpMessage) => void;
  reject: (err: Error) => void;
}

const [path, outdir, ...steps] = process.argv.slice(2);
if (!path || !outdir) {
  console.error("usage: node scripts/drive.mts <path> <outdir> <step>...");
  process.exit(2);
}
mkdirSync(outdir, { recursive: true });

const cache = `${process.env.HOME}/Library/Caches/ms-playwright`;
const shell = readdirSync(cache)
  .filter((d) => d.startsWith("chromium_headless_shell-"))
  .sort()
  .at(-1);
const chrome =
  process.env.CHROME ?? `${cache}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(chrome, [
  "--headless",
  `--remote-debugging-port=${port}`,
  `--window-size=${process.env.SIZE ?? "412,860"}`,
  "--force-prefers-reduced-motion",
  "--hide-scrollbars",
  "about:blank",
]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let failed = false;

try {
  let targets: { type: string; webSocketDebuggerUrl: string }[] | undefined;
  for (let i = 0; !targets && i < 50; i++) {
    targets = await fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .catch(() => sleep(200).then(() => undefined));
  }
  const page = targets?.find((t) => t.type === "page");
  if (!page) throw new Error("the browser opened no page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let seq = 0;
  const pending = new Map<number, Pending>();
  let loaded = () => {};
  // Vite echoes server and client console errors into each other: print each one once.
  const seen = new Set<string>();
  const report = (kind: string, text: string) => {
    const line = `${kind}: ${text}`.replace(/\s+/g, " ").slice(0, 300);
    if (!seen.has(line)) console.error((seen.add(line), line));
  };
  ws.addEventListener("message", (e) => {
    const m: CdpMessage = JSON.parse(String(e.data));
    if (m.id) pending.get(m.id)?.resolve(m);
    if (m.method === "Page.loadEventFired") loaded();
    if (m.method === "Runtime.exceptionThrown") {
      report("page exception", m.params.exceptionDetails.exception?.description);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      const args: unknown[] = m.params.args.map(
        (a: { value?: unknown; description?: string }) => a.value ?? a.description,
      );
      report("page console.error", args.filter((a) => !String(a).includes("%c")).join(" "));
    }
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("the browser closed the connection"));
  });
  const send = (method: string, params: object = {}) =>
    new Promise<CdpMessage>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => reject(new Error(`${method}: no answer in 15s`)), 15000);
      pending.set(id, {
        resolve: (m) => (clearTimeout(timer), pending.delete(id), resolve(m)),
        reject,
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression: string): Promise<unknown> =>
    (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result
      ?.result?.value;

  await send("Page.enable");
  await send("Runtime.enable");
  const load = new Promise<void>((r) => (loaded = r));
  await send("Page.navigate", { url: `${process.env.BASE_URL ?? "http://127.0.0.1:3000"}${path}` });
  await Promise.race([load, sleep(30000)]);
  await sleep(1000); // hydration

  for (const step of steps) {
    const [verb, ...rest] = step.split(":");
    const arg = rest.join(":");
    if (verb === "wait") await sleep(Number(arg));
    else if (verb === "shot") {
      const r = await send("Page.captureScreenshot", { format: "png" });
      writeFileSync(`${outdir}/${arg}.png`, Buffer.from(r.result.data, "base64"));
      console.log(`${outdir}/${arg}.png`);
    } else if (verb === "click" || verb === "press") {
      const find =
        verb === "press"
          ? `document.querySelector(${JSON.stringify(arg)})`
          : `[...document.querySelectorAll("button, a, span")].find((e) => e.textContent.trim() === ${JSON.stringify(arg)})`;
      let clicked = false;
      for (let i = 0; !clicked && i < 50; i++) {
        clicked =
          (await run(`(() => { const el = ${find}; el?.click(); return !!el; })()`)) === true;
        if (!clicked) await sleep(200);
      }
      if (!clicked) throw new Error(`${step}: no such element`);
      await sleep(300);
    } else throw new Error(`unknown step: ${step}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  failed = true;
} finally {
  browser.kill();
}
process.exit(failed ? 1 : 0);
