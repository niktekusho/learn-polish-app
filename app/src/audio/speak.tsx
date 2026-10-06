import { Volume2 } from "lucide-react";

/** Hear Polish text via the browser's own TTS (pl-PL voice from the OS). See ADR-0004. */
export function speak(text: string) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "pl-PL";
  // ponytail: first Polish voice the OS offers; no voice picker. If none is
  // installed the browser falls back to its default voice (wrong accent).
  const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith("pl"));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

export function ListenButton({
  text,
  label = "Listen",
  className = "mt-3",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  if (typeof speechSynthesis === "undefined") return null;
  return (
    <button
      type="button"
      onClick={() => speak(text)}
      className={`${className} flex items-center gap-1 rounded border border-gray-300 px-3 py-1 text-sm text-gray-700 hover:bg-gray-50`}
    >
      <Volume2 size={16} /> {label}
    </button>
  );
}
