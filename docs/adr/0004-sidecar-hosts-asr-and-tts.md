# Sidecar hosts ASR and TTS (charter grows from morphology to Python ML services)

ADR-0001 justified the Python sidecar solely because Polish morphology has no good JS
equivalent. Speech features need ASR (grading spoken answers) and TTS (listening
dictation prompts), and here JS equivalents *do* exist — Whisper via transformers.js in
the browser, and the native `speechSynthesis` API — so the original rationale no longer
decides. We run both in the existing sidecar anyway: **faster-whisper** for ASR and
**Piper** for TTS. The sidecar's charter is now "Python ML services", not
morphology-only.

## Considered options

- **ASR in browser (transformers.js WASM):** rejected — ~200MB+ model download, slow on
  CPU, weaker accuracy on our hardest case (single Polish words from a non-native
  speaker), and grading would move client-side against the server-held-item pattern
  established in MVP issue #9.
- **TTS via browser `speechSynthesis`:** rejected for voice quality — Piper's neural
  voices are clearly better and the sidecar pattern is already paid for by ASR.
- **Cloud APIs (OpenAI/Groq Whisper, cloud TTS):** rejected — app is local-first;
  per-call cost and audio leaving the machine both unwanted.

## Consequences

- Heavier sidecar: models on disk, first-call load latency to manage.
- Swap cost stays contained: browser only records/plays audio; ASR and TTS sit behind
  HTTP endpoints.
- README's original "Whisper (JS)" note is superseded by this decision.
