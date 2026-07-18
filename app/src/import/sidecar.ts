// Client for the Python ML sidecar (#2, ADR-0004). Server-only: called from a
// server function, never bundled to the browser.

export interface AnalyzedToken {
  surface: string
  lemma: string
  pos: string // UPOS: NOUN, VERB, ADP, PUNCT, ...
  tags: string[]
  is_space: boolean
}
export interface AnalyzedSentence {
  tokens: AnalyzedToken[]
}
export interface AnalyzeResponse {
  sentences: AnalyzedSentence[]
}

const SIDECAR_URL = process.env.SIDECAR_URL ?? 'http://localhost:8000'

export async function analyze(text: string): Promise<AnalyzeResponse> {
  const res = await fetch(`${SIDECAR_URL}/analyze`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    throw new Error(`sidecar /analyze failed: ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as AnalyzeResponse
}

/**
 * ASR (ADR-0004): browser-recorded audio in (ogg/webm/mp4 — PyAV sniffs the
 * container, filename is decoration), raw Polish transcript out. First call
 * ever is slow: the sidecar lazy-loads (and once, downloads) the model.
 */
export async function transcribe(audio: Blob): Promise<string> {
  const form = new FormData()
  form.append('audio', audio, 'clip')
  const res = await fetch(`${SIDECAR_URL}/transcribe`, {
    method: 'POST',
    body: form,
  })
  if (!res.ok) {
    throw new Error(`sidecar /transcribe failed: ${res.status} ${res.statusText}`)
  }
  return ((await res.json()) as { text: string }).text
}
