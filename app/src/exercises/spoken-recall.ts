import { Rating } from '#/fsrs/index'
import type { Exercise } from './types'

/** Full item, held server-side. `lemma` IS the answer — never sent to client. */
export interface SpokenRecallItem {
  id: string
  lemmaId: number
  lemma: string // the Polish tracked unit to say
  gloss: string // the Italian prompt
}
export interface SpokenRecallClientItem {
  id: string
  kind: 'spoken-recall'
  gloss: string
}
/** Server-derived from the audio: ASR transcript + its /analyze lemmas. */
export interface SpokenResponse {
  transcriptText: string
  transcriptLemmas: string[]
}

/** Lowercase, letters/digits only — punctuation and casing are ASR noise. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Polish phonetic fold. Whisper hears non-native single words nearly right
 * but spells them wrong ('szykowacz' for *szykować*), so grading compares
 * phonetic keys, not orthography. Three rule groups:
 * - orthographic identities (rz=ż, ó=u, ch=h — same sound, two spellings);
 * - palatal/retroflex pairs ASR reliably confuses on non-native audio
 *   (ć/cz→c, ś/sz→s, ź/ż→z), plus y→i and denasalized ę/ą;
 * - collapse repeats.
 * Known cost: real minimal pairs fold together (być=bić, morze=może). This
 * grades vocabulary recall, not pronunciation precision — acceptable at
 * sub-A1, and the self-grade fallback stays the escape hatch.
 */
export function phoneticKey(s: string): string {
  return normalize(s)
    .replace(/ch/g, 'h')
    .replace(/rz/g, 'z')
    .replace(/sz/g, 's')
    .replace(/cz/g, 'c')
    .replace(/d[żź]/g, 'z')
    .replace(/[żź]/g, 'z')
    .replace(/ś/g, 's')
    .replace(/ć/g, 'c')
    .replace(/ó/g, 'u')
    .replace(/ł/g, 'l')
    .replace(/ę/g, 'e')
    .replace(/ą/g, 'a')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diag = prev[j]
      prev[j] = cur
    }
  }
  return prev[b.length]
}

/** Edit-distance budget on phonetic keys, scaled by target length: short
 * words must match exactly (kot/kod stay distinct), longer ones absorb the
 * ending-garble whisper produces ('siklowac' ≈ 'sikowac'). */
function keyBudget(keyLen: number): number {
  if (keyLen <= 4) return 0
  if (keyLen <= 7) return 1
  return 2
}

function keysMatch(targetKey: string, wordKey: string): boolean {
  return levenshtein(targetKey, wordKey) <= keyBudget(targetKey.length)
}

/**
 * Did the learner say `target`? Single lemma: phonetic-fuzzy match against
 * every transcript lemma AND raw word (lemmatizing 'kota' → 'kot' catches
 * inflected answers; the raw words catch garbles the lemmatizer left alone).
 * MWE targets (contain a space): substring match on the folded transcript.
 */
export function transcriptMatches(
  target: string,
  response: SpokenResponse,
): boolean {
  const t = normalize(target)
  if (!t) return false
  if (t.includes(' ')) {
    const seq = ` ${phoneticKey(response.transcriptLemmas.join(' '))} `
    const text = ` ${phoneticKey(response.transcriptText)} `
    const key = ` ${phoneticKey(t)} `
    return seq.includes(key) || text.includes(key)
  }
  const targetKey = phoneticKey(t)
  const words = [
    ...response.transcriptLemmas.map(normalize),
    ...normalize(response.transcriptText).split(' '),
  ]
  return words.some((w) => w && keysMatch(targetKey, phoneticKey(w)))
}

/**
 * Spoken recall (roadmap Slice 1): Italian gloss shown → say the Polish
 * tracked unit. The productive track's first feeder. ASR-miss fallback
 * (reveal + self-grade) lives in the session layer — `grade` here only maps
 * a transcript to a rating.
 */
export const spokenRecall: Exercise<
  SpokenRecallItem,
  SpokenRecallClientItem,
  SpokenResponse
> = {
  id: 'spoken-recall',
  tracks: ['productive'],
  modality: { prompt: 'text', answer: 'speak' },

  // PROPN excluded: producing "Ola" from "nome proprio" is name-guessing,
  // not vocabulary retrieval.
  appliesTo: (c) =>
    typeof c.gloss === 'string' && c.gloss.length > 0 && c.pos !== 'PROPN',

  generate(target) {
    if (!target.gloss) return null
    return {
      id: crypto.randomUUID(),
      lemmaId: target.lemmaId,
      lemma: target.lemma,
      gloss: target.gloss,
    }
  },

  toClient: (item) => ({
    id: item.id,
    kind: 'spoken-recall',
    gloss: item.gloss,
  }),

  grade: (item, response) =>
    transcriptMatches(item.lemma, response) ? Rating.Good : Rating.Again,
}
