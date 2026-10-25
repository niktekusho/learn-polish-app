import { Check } from "lucide-react";

const BTN =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded px-4 py-3 text-center text-base leading-tight font-semibold disabled:opacity-45 disabled:shadow-none";
export const BTN_PRIMARY = `${BTN} bg-accent text-white shadow-button`;
export const BTN_QUIET = `${BTN} border-[1.5px] border-accent/45 bg-panel text-accent-ink`;
export const BTN_GOOD = `${BTN} border-[1.5px] border-good bg-good-soft text-good-ink`;
export const BTN_BAD = `${BTN} border-[1.5px] border-bad bg-bad-soft text-bad-ink`;
export const LABEL_TYPE = "font-sans text-xs font-semibold tracking-[0.06em] uppercase";
export const LABEL = `${LABEL_TYPE} text-ink-3`;
export const TOOL =
  "inline-flex min-h-11 items-center gap-2 rounded px-2 text-sm font-medium text-accent-ink";
export const ERROR_LINE =
  "flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-sm font-medium text-bad-ink";
export const RETRY = "min-h-11 font-semibold underline";
export const ICON_BUTTON =
  "inline-grid size-11 shrink-0 place-items-center rounded-full text-ink-2 active:bg-ink/5 aria-expanded:bg-ink/5";

// A multiple-choice answer: Comprehension check and Practice.
export const CHOICE =
  "flex min-h-12 w-full items-center gap-3 rounded border-[1.5px] px-4 py-3 text-left font-serif text-[16px] leading-[1.35]";
export const CHOICE_STATE = {
  idle: "border-rule bg-panel",
  picked: "border-accent bg-accent-soft",
  right: "border-good bg-good-soft text-good-ink",
  wrong: "border-bad bg-bad-soft text-bad-ink",
  off: "border-rule bg-panel opacity-55",
};

export function Tick() {
  return (
    <span className="inline-grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
      <Check size={17} strokeWidth={2.6} />
    </span>
  );
}
