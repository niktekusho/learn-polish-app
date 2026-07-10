// One rendered token in the reader. Word tokens have a lemma; layout and
// punctuation tokens have lemmaId === null. `known` is the server-decided
// receptive-knowledge verdict (see reader/knowledge.ts) — the UI highlights on
// this boolean, never on a raw FSRS state enum.
export interface ReaderToken {
  surface: string
  isSpace: boolean
  position: number
  sentenceIndex: number
  lemmaId: number | null
  lemma: string | null
  pos: string | null
  known: boolean
}
