// Client for the Python morphology sidecar (#2). Server-only: called from a
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
