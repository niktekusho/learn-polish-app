import type { ReaderToken } from './types'

// Word detail panel. #5 shows the surface/lemma/POS; #6 fills in the Italian
// gloss and the Wiktionary link.
export function WordPanel({
  token,
  onClose,
}: {
  token: ReaderToken
  onClose: () => void
}) {
  return (
    <aside className="fixed right-0 top-0 h-full w-80 border-l border-gray-200 bg-white p-6 shadow-lg">
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 text-gray-400 hover:text-gray-700"
      >
        ✕
      </button>

      <div className="text-2xl font-bold">{token.surface}</div>
      <dl className="mt-4 space-y-2 text-sm">
        <div>
          <dt className="text-gray-500">Lemma</dt>
          <dd className="font-medium">{token.lemma}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Part of speech</dt>
          <dd className="font-medium">{token.pos}</dd>
        </div>
      </dl>

      {/* #6 adds the Italian gloss + Wiktionary link here. */}
    </aside>
  )
}
