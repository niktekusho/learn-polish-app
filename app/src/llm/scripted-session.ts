import type { ConversationSession, SessionSeed, TurnResult } from "./conversation-session";

/** Canned turns, so dev and tests run offline. `stepIndex` picks the step id each turn ticks. */
const SCRIPT: { turn: Omit<TurnResult, "stepsTicked">; stepIndex: number | null }[] = [
  {
    stepIndex: null,
    turn: {
      line: "Dzień dobry! W czym mogę pomóc?",
      italian: "Buongiorno! Come posso aiutarla?",
      understood: true,
      hint: ["poproszę", "bułki"],
      modelLine: "Poproszę dwie bułki.",
    },
  },
  {
    stepIndex: 0,
    turn: {
      line: "Dwie bułki, proszę bardzo. Coś jeszcze?",
      italian: "Due panini, prego. Altro?",
      understood: true,
      hint: ["to wszystko"],
      modelLine: "Nie, to wszystko, dziękuję.",
    },
  },
  {
    stepIndex: 1,
    turn: {
      line: "To będzie cztery złote.",
      italian: "Sono quattro zloty.",
      understood: true,
      hint: ["proszę"],
      modelLine: "Proszę, cztery złote.",
    },
  },
];

export class ScriptedSession implements ConversationSession {
  private stepIds: string[] | null = null;
  private next = 0;

  async start(seed: SessionSeed): Promise<TurnResult> {
    this.stepIds = seed.stepIds;
    this.next = 0;
    return this.play();
  }

  /** The opening and the replies already in the transcript are skipped in the script. */
  warm(seed: SessionSeed): void {
    this.stepIds = seed.stepIds;
    this.next = seed.transcript.filter((l) => l.speaker === "character").length;
  }

  async send(): Promise<TurnResult> {
    if (!this.stepIds) throw new Error("session not started");
    return this.play();
  }

  close(): void {}

  private play(): TurnResult {
    const { turn, stepIndex } = SCRIPT[Math.min(this.next++, SCRIPT.length - 1)];
    const step = stepIndex === null ? undefined : this.stepIds![stepIndex];
    return { ...turn, stepsTicked: step ? [step] : [] };
  }
}
