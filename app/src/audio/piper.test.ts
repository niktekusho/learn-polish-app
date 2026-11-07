import { afterEach, expect, test, vi } from "vitest";
import { handleSpeak } from "./piper";

const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

function stubSidecar(res: Response) {
  const fetch = vi.fn(async () => res);
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function get(query: string) {
  return handleSpeak(new Request(`http://app.test/api/speak?${query}`));
}

test("plays the sidecar's audio for a sentence in the chosen voice", async () => {
  const fetch = stubSidecar(new Response(wav, { headers: { "content-type": "audio/wav" } }));

  const res = await get(new URLSearchParams({ text: "Dzień dobry.", voice: "gosia" }).toString());

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/wav");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(wav);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toMatch(/\/speak$/);
  expect(JSON.parse(init.body as string)).toEqual({ text: "Dzień dobry.", voice: "gosia" });
});

test("passes the sidecar's rejection of an unknown voice through", async () => {
  stubSidecar(Response.json({ detail: "Unknown voice 'zosia'." }, { status: 400 }));

  const res = await get("text=Cze%C5%9B%C4%87&voice=zosia");

  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ detail: "Unknown voice 'zosia'." });
});

test("rejects a request without text or voice before calling the sidecar", async () => {
  const fetch = stubSidecar(new Response(wav));

  expect((await get("voice=gosia")).status).toBe(400);
  expect((await get("text=Cze%C5%9B%C4%87")).status).toBe(400);
  expect(fetch).not.toHaveBeenCalled();
});
