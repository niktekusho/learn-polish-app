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

export function ListenButton({ text, label = "Ascolta" }: { text: string; label?: string }) {
  if (typeof speechSynthesis === "undefined") return null;
  return (
    <button
      type="button"
      onClick={() => speak(text)}
      className="inline-flex min-h-11 items-center gap-2 justify-self-start rounded-full bg-accent-soft px-4 text-sm font-semibold text-accent-ink"
    >
      <Volume2 size={17} /> {label}
    </button>
  );
}
