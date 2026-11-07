import { speak } from "#/import/sidecar";

/** Server side of `/api/speak?text=…&voice=…`: a GET URL so an `<audio>` element can play it. */
export async function handleSpeak(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const text = query.get("text");
  const voice = query.get("voice");
  if (!text || !voice) {
    return Response.json({ detail: "text and voice are required." }, { status: 400 });
  }
  const res = await speak(text, voice);
  if (!res.ok) {
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "text/plain" },
    });
  }
  // The same text in the same voice always gives the same audio.
  return new Response(res.body, {
    headers: { "content-type": "audio/wav", "cache-control": "private, max-age=86400" },
  });
}
