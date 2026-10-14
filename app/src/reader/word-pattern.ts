/** Matches `word` as a whole word: a short target like "do" must not match inside "domu". */
export function wordPattern(word: string, flags = "iu"): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}])(${escaped})(?![\\p{L}])`, flags);
}
