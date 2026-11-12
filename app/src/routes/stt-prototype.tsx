// PROTOTYPE (#41), throwaway: a bench for the capture and sidecar changes listed
// in docs/research/browser-audio-capture-for-stt.md. Each recording is sent
// twice to the sidecar's /transcribe-prototype: once with the prod settings and
// once with the options ticked below. Grades nothing and writes nothing to the DB.
import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

const onOff = z.union([z.literal(0), z.literal(1)]);
const searchSchema = z.object({
  ec: onOff.default(1).catch(1),
  ns: onOff.default(1).catch(1),
  agc: onOff.default(1).catch(1),
});

interface SidecarResult {
  text: string;
  avg_logprob: number | null;
  no_speech_prob: number | null;
  temperatures: number[];
  stats: {
    seconds: number;
    peak_db: number | null;
    speech_db: number;
    noise_db: number;
    zero_frames_pct: number;
  };
}

const transcribeFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    if (!(d instanceof FormData)) throw new Error("expected FormData");
    const audio = d.get("audio");
    if (!(audio instanceof Blob)) throw new Error("missing audio");
    return { audio, query: String(d.get("query") ?? "") };
  })
  .handler(async ({ data }): Promise<SidecarResult> => {
    const base = process.env.SIDECAR_URL ?? "http://localhost:8000";
    const form = new FormData();
    form.append("audio", data.audio, "clip");
    const res = await fetch(`${base}/transcribe-prototype?${data.query}`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`sidecar ${res.status}: ${await res.text()}`);
    return (await res.json()) as SidecarResult;
  });

export const Route = createFileRoute("/stt-prototype")({
  component: SttPrototype,
  validateSearch: (s) => searchSchema.parse(s),
});

interface Row {
  name: string;
  result?: SidecarResult;
  error?: string;
}
interface Attempt {
  id: number;
  capture: string;
  applied: string;
  url: string;
  rows: Row[];
}

const MIME = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4"];

function SttPrototype() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [normalize, setNormalize] = useState(true);
  const [vadOff, setVadOff] = useState(false);
  const [temperature0, setTemperature0] = useState(false);
  const [hotwords, setHotwords] = useState("");
  const [applied, setApplied] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  // The stream is reacquired whenever a capture constraint changes.
  useEffect(() => {
    let cancelled = false;
    setApplied("");
    setMicError(null);
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: search.ec === 1,
          noiseSuppression: search.ns === 1,
          autoGainControl: search.agc === 1,
        },
      })
      .then((stream) => {
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        const track = stream.getAudioTracks()[0];
        const s = track.getSettings();
        // What the browser reports it applied, which can differ from the request.
        setApplied(
          `${track.label} | ec=${s.echoCancellation} ns=${s.noiseSuppression} agc=${s.autoGainControl} | ${s.sampleRate} Hz, ${s.channelCount} ch`,
        );
      })
      .catch((e) => setMicError(String(e)));
    return () => {
      cancelled = true;
      if (streamRef.current) for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    };
  }, [search.ec, search.ns, search.agc]);

  const capture = `ec${search.ec}-ns${search.ns}-agc${search.agc}`;

  function patch(id: number, name: string, row: Partial<Row>) {
    setAttempts((all) =>
      all.map((a) =>
        a.id === id
          ? { ...a, rows: a.rows.map((r) => (r.name === name ? { ...r, ...row } : r)) }
          : a,
      ),
    );
  }

  async function send(blob: Blob) {
    const candidate = new URLSearchParams({ label: capture });
    const parts: string[] = [];
    if (normalize) {
      candidate.set("normalize", "true");
      parts.push("normalize");
    }
    if (vadOff) {
      candidate.set("vad", "false");
      parts.push("VAD off");
    }
    if (temperature0) {
      candidate.set("temperature0", "true");
      parts.push("temperature 0");
    }
    if (hotwords.trim()) {
      candidate.set("hotwords", hotwords.trim());
      parts.push(`hotwords "${hotwords.trim()}"`);
    }
    const variants = [{ name: "prod settings", query: `label=${capture}` }];
    if (parts.length) variants.push({ name: parts.join(" + "), query: candidate.toString() });

    const id = Date.now();
    setAttempts((all) => [
      {
        id,
        capture,
        applied,
        url: URL.createObjectURL(blob),
        rows: variants.map((v) => ({ name: v.name })),
      },
      ...all,
    ]);
    for (const v of variants) {
      const form = new FormData();
      form.append("audio", blob);
      form.append("query", v.query);
      try {
        patch(id, v.name, { result: await transcribeFn({ data: form }) });
      } catch (e) {
        patch(id, v.name, { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  function start() {
    const stream = streamRef.current;
    if (!stream || recorderRef.current) return;
    const mimeType = MIME.find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      recorderRef.current = null;
      setRecording(false);
      void send(new Blob(chunks, { type: rec.mimeType }));
    };
    recorderRef.current = rec;
    rec.start();
    setRecording(true);
  }

  function stop() {
    const rec = recorderRef.current;
    // Same 250 ms tail as the real recorder.
    if (rec) setTimeout(() => rec.state === "recording" && rec.stop(), 250);
  }

  const toggle = (key: "ec" | "ns" | "agc", label: string) => (
    <label className="flex min-h-11 items-center gap-2">
      <input
        type="checkbox"
        checked={search[key] === 1}
        onChange={(e) =>
          navigate({ search: (s) => ({ ...s, [key]: e.target.checked ? 1 : 0 }), replace: true })
        }
      />
      {label}
    </label>
  );
  const option = (checked: boolean, set: (v: boolean) => void, label: string) => (
    <label className="flex min-h-11 items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
      {label}
    </label>
  );

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link to="/maintenance" className="inline-flex min-h-11 items-center text-sm underline">
        Maintenance
      </Link>
      <h1 className="mt-2 text-2xl font-bold">STT prototype</h1>
      <p className="mt-1 text-sm text-ink-3">
        Throwaway bench for #41. Nothing here is graded or stored in the database.
      </p>

      <div className="mt-6 rounded border border-gray-200 p-4">
        <h2 className="font-semibold">Capture (browser)</h2>
        <p className="text-sm text-ink-3">The app records with all three on today.</p>
        {toggle("ec", "Echo cancellation")}
        {toggle("ns", "Noise suppression")}
        {toggle("agc", "Auto gain control")}
        <p className="mt-2 text-xs break-words text-ink-3">
          {micError ? `Mic error: ${micError}` : `Applied: ${applied || "acquiring mic"}`}
        </p>
      </div>

      <div className="mt-4 rounded border border-gray-200 p-4">
        <h2 className="font-semibold">Sidecar candidate</h2>
        <p className="text-sm text-ink-3">
          Each clip is also transcribed with the prod settings, for comparison.
        </p>
        {option(normalize, setNormalize, "Peak-normalize to -3 dBFS before the VAD")}
        {option(vadOff, setVadOff, "VAD off")}
        {option(temperature0, setTemperature0, "Temperature 0 (no sampling fallback)")}
        <input
          value={hotwords}
          onChange={(e) => setHotwords(e.target.value)}
          placeholder="Hotwords: the expected words, space separated"
          className="mt-2 min-h-11 w-full rounded border border-gray-300 px-3"
        />
      </div>

      <div className="mt-6 grid justify-items-center">
        <button
          type="button"
          disabled={!applied}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            start();
          }}
          onPointerUp={stop}
          onPointerCancel={stop}
          onContextMenu={(e) => e.preventDefault()}
          className={`size-24 touch-none rounded-full font-semibold text-white select-none disabled:opacity-45 ${
            recording ? "bg-bad" : "bg-accent"
          }`}
        >
          {recording ? "Release" : "Hold"}
        </button>
      </div>

      <ul className="mt-6 grid gap-4">
        {attempts.map((a) => {
          const stats = a.rows.find((r) => r.result)?.result?.stats;
          return (
            <li key={a.id} className="rounded border border-gray-200 p-4 text-sm">
              <p className="font-semibold">{a.capture}</p>
              <p className="text-xs break-words text-ink-3">{a.applied}</p>
              {/* biome-ignore lint/a11y/useMediaCaption: prototype playback of the learner's own clip */}
              <audio controls src={a.url} className="mt-2 w-full" />
              {stats && (
                <p className="mt-2 text-xs text-ink-3">
                  {stats.seconds} s | peak {stats.peak_db} dBFS | speech {stats.speech_db} dB |
                  noise floor {stats.noise_db} dB | digital-silence frames {stats.zero_frames_pct}%
                </p>
              )}
              <table className="mt-2 w-full text-left">
                <tbody>
                  {a.rows.map((r) => (
                    <tr key={r.name} className="border-t border-gray-200 align-top">
                      <td className="py-1 pr-2 text-xs text-ink-3">{r.name}</td>
                      <td className="py-1 pr-2 font-semibold">
                        {r.error ?? (r.result ? r.result.text || "(empty)" : "transcribing")}
                      </td>
                      <td className="py-1 text-xs whitespace-nowrap text-ink-3">
                        {r.result &&
                          `logprob ${r.result.avg_logprob ?? "n/a"}, no-speech ${r.result.no_speech_prob ?? "n/a"}, temp ${r.result.temperatures.join(",") || "n/a"}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
