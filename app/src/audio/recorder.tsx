import { Mic } from 'lucide-react'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'

/**
 * Mic capture for the speaking exercises (roadmap Slice 1).
 *
 * Container is whatever the browser records natively — Firefox picks
 * ogg/opus, Chrome webm/opus, Safari mp4 — and the sidecar (PyAV) decodes
 * all of them, so there is no per-browser code beyond this list.
 */
const MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/mp4',
]

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m))
}

/**
 * Loudest a recording's RMS envelope may peak and still be rejected as too
 * quiet to transcribe. The real failing clips (2026-07-13) sat at whole-clip
 * RMS −43…−49 dB; normal speech peaks near −20 dB. 0.02 linear ≈ −34 dB is the
 * gap between them.
 * ponytail: calibration knob — retune against a few of YOUR good clips on YOUR
 * mic if it warns on acceptable audio (or misses genuine near-silence).
 */
const QUIET_RMS_THRESHOLD = 0.02

// Meter display range: map RMS dBFS to a 0..1 bar. −55 dB empty, −15 dB full.
const METER_FLOOR_DB = -55
const METER_CEIL_DB = -15

export function rms(buf: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}

/** Linear RMS → 0..1 meter position over METER_FLOOR_DB…METER_CEIL_DB. */
export function meterLevel(rmsValue: number): number {
  const db = 20 * Math.log10(rmsValue + 1e-9)
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_CEIL_DB - METER_FLOOR_DB)))
}

export type RecorderState =
  | 'idle'
  | 'recording'
  | 'tooQuiet' // captured, but never crossed the loudness gate — not sent
  | 'denied'
  | 'unsupported'

/**
 * Hold-to-record. The mic stream is acquired once (on mount, so the first
 * press doesn't clip the word start while getUserMedia resolves) and released
 * on unmount. An AnalyserNode taps the same stream for a live level meter and
 * a too-quiet gate. Each press runs one MediaRecorder start/stop cycle.
 */
export function useRecorder(onRecorded: (blob: Blob) => void) {
  const [state, setState] = useState<RecorderState>('idle')
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const peakRmsRef = useRef(0) // loudest RMS frame seen this recording
  const meterFillRef = useRef<HTMLDivElement | null>(null) // meter bar, written imperatively
  // Non-reactive: always the latest onRecorded, without making it a dep of the
  // callbacks below. Replaces the manual latest-callback ref idiom.
  const emitRecorded = useEffectEvent(onRecorded)

  useEffect(() => {
    let cancelled = false
    if (!navigator.mediaDevices?.getUserMedia || !pickMimeType()) {
      setState('unsupported')
      return
    }
    navigator.mediaDevices
      .getUserMedia({
        // Explicit speech-processing constraints: browser defaults vary, and
        // a mic without auto-gain can record near-silence whisper can't use.
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then((stream) => {
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop()
          return
        }
        streamRef.current = stream
        // Tap the stream for analysis. Analyser is left unconnected to
        // destination on purpose — routing mic to speakers would feed back.
        const ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        ctx.createMediaStreamSource(stream).connect(analyser)
        ctxRef.current = ctx
        analyserRef.current = analyser
      })
      .catch(() => {
        if (!cancelled) setState('denied')
      })
    return () => {
      cancelled = true
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      recorderRef.current?.stop()
      ctxRef.current?.close()
      if (streamRef.current) for (const t of streamRef.current.getTracks()) t.stop()
      streamRef.current = null
    }
  }, [])

  // rAF loop: read the analyser each frame, drive the meter, remember the
  // peak. Runs only between start() and the actual MediaRecorder stop. The
  // meter is written straight to the DOM — a per-frame setState would re-render
  // the consumer ~60×/s for a value that never feeds anything but this bar.
  const monitor = useCallback(() => {
    const analyser = analyserRef.current
    if (!analyser) return
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    const r = rms(buf)
    if (r > peakRmsRef.current) peakRmsRef.current = r
    const el = meterFillRef.current // null on the first tick(s), before mount
    if (el) {
      const lvl = meterLevel(r)
      el.style.width = `${Math.round(lvl * 100)}%`
      const quiet = lvl < meterLevel(QUIET_RMS_THRESHOLD)
      el.classList.toggle('bg-red-400', quiet)
      el.classList.toggle('bg-green-500', !quiet)
    }
    rafRef.current = requestAnimationFrame(monitor)
  }, [])

  const start = useCallback(() => {
    const stream = streamRef.current
    if (!stream || recorderRef.current) return
    ctxRef.current?.resume() // may be suspended until a user gesture
    peakRmsRef.current = 0
    const mimeType = pickMimeType()
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const chunks: BlobPart[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    rec.onstop = () => {
      recorderRef.current = null
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      // Loudness gate: if even the loudest frame stayed below threshold, the
      // clip is too quiet to transcribe — surface it instead of sending.
      if (peakRmsRef.current < QUIET_RMS_THRESHOLD) {
        setState('tooQuiet')
        return
      }
      setState('idle')
      // Effect Event called from an imperative media callback (not an Effect) —
      // works, and there's no linter to quibble; the intent is "read latest
      // onRecorded, non-reactively".
      emitRecorded(new Blob(chunks, { type: rec.mimeType }))
    }
    recorderRef.current = rec
    rec.start()
    setState('recording')
    rafRef.current = requestAnimationFrame(monitor)
  }, [monitor])

  const stop = useCallback(() => {
    const rec = recorderRef.current
    if (rec && rec.state === 'recording') {
      // Tail grace: the button is usually released on the last syllable;
      // stopping instantly clips the word end and tanks ASR accuracy.
      setTimeout(() => {
        if (rec.state === 'recording') rec.stop()
      }, 250)
    }
  }, [])

  /** Clear the too-quiet warning, back to a fresh idle ready to retry. */
  const dismiss = useCallback(() => setState('idle'), [])

  return { state, meterFillRef, start, stop, dismiss }
}

/**
 * Push-to-talk: pointer events give one code path for mouse and touch;
 * keydown/keyup adds spacebar hold on desktop. Long-press context menu
 * (Android) and text selection are suppressed. A live meter shows input level
 * while holding; releasing on a too-quiet clip warns instead of sending.
 */
export function PushToTalk({
  onRecorded,
  disabled = false,
}: {
  onRecorded: (blob: Blob) => void
  disabled?: boolean
}) {
  const { state, meterFillRef, start, stop, dismiss } = useRecorder(onRecorded)

  useEffect(() => {
    if (disabled) return
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && e.target === document.body) {
        e.preventDefault()
        start()
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') stop()
    }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    return () => {
      document.removeEventListener('keydown', down)
      document.removeEventListener('keyup', up)
    }
  }, [disabled, start, stop])

  if (state === 'unsupported')
    return <p className="text-sm text-red-600">No mic support in this browser.</p>
  if (state === 'denied')
    return (
      <p className="text-sm text-red-600">
        Mic permission denied — allow it in the browser and reload.
      </p>
    )

  const recording = state === 'recording'
  return (
    <div className="flex flex-col items-start gap-2">
      <button
        type="button"
        disabled={disabled}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          start()
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onContextMenu={(e) => e.preventDefault()}
        className={`flex select-none items-center gap-2 rounded-full border px-6 py-3 font-medium touch-none ${
          recording
            ? 'border-red-500 bg-red-50 text-red-700'
            : 'border-gray-300 hover:bg-gray-50 disabled:opacity-50'
        }`}
      >
        <Mic size={18} className={recording ? 'animate-pulse' : ''} />
        {recording ? 'Recording… release to send' : 'Hold to speak (or hold Space)'}
      </button>

      {recording && (
        <div className="h-2 w-48 overflow-hidden rounded-full bg-gray-200">
          {/* width + color written imperatively by the rAF loop; starts empty/red */}
          <div ref={meterFillRef} className="h-full w-0 bg-red-400" />
        </div>
      )}

      {state === 'tooQuiet' && (
        <p className="text-sm text-red-600">
          Too quiet to hear — speak up or raise your mic level, then hold again.{' '}
          <button type="button" onClick={dismiss} className="underline">
            Dismiss
          </button>
        </p>
      )}
    </div>
  )
}
