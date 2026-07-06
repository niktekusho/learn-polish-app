// One rendered token in the reader. Word tokens have a lemma; layout and
// punctuation tokens have lemmaId === null. `known` / `stillLearning` are the
// server-decided receptive-knowledge verdicts (see reader/knowledge.ts) — the
// UI renders on these booleans, never on a raw FSRS state enum.
export interface ReaderToken {
  surface: string
  isSpace: boolean
  position: number
  sentenceIndex: number
  lemmaId: number | null
  lemma: string | null
  pos: string | null
  known: boolean
  stillLearning: boolean
}

// The server's verdict after grading a lemma, used to update highlights live.
export interface KnowledgeFlags {
  known: boolean
  stillLearning: boolean
}
