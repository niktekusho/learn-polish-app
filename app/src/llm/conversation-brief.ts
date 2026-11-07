import type { learnerProfile } from "#/db/schema";

export interface GoalStep {
  id: string;
  text: string; // Italian, as the learner reads it on the card
}

export type BriefProfile = Pick<
  typeof learnerProfile.$inferSelect,
  "name" | "job" | "city" | "partner" | "hobbies"
>;

export interface CharacterBrief {
  character: string; // who the character is, in Italian
  scene: string; // where and when the scene happens, in Italian
  steps: GoalStep[];
  roleFacts: string | null; // the facts of a role the Goal assigns the learner
  profile: BriefProfile;
  memory: string[]; // Character memory lines
  dueLemmas: string[]; // due Productive lemmas the scene should make the natural answer
}

/** The system prompt of a Conversation session. Field names match the turn result schema. */
export function buildCharacterBrief(b: CharacterBrief): string {
  const p = b.profile;
  const sections = [
    `Sei ${b.character}, madrelingua polacco. Fai un gioco di ruolo parlato con uno ` +
      "studente italiano di polacco, principiante (sotto A1).",
    `Scena: ${b.scene}`,
    `Obiettivo dello studente (id: passo):\n${b.steps.map((s) => `- ${s.id}: ${s.text}`).join("\n")}`,
    b.roleFacts && `Il ruolo dello studente: ${b.roleFacts}`,
    `Lo studente: si chiama ${p.name}, lavoro: ${p.job}, vive a ${p.city}, ` +
      `partner: ${p.partner}, hobby: ${p.hobbies}.`,
    b.memory.length > 0 && `Ricordi sullo studente:\n${b.memory.map((m) => `- ${m}`).join("\n")}`,
    b.dueLemmas.length > 0 &&
      `Parole che lo studente sta ripassando: ${b.dueLemmas.join(", ")}. Quando viene ` +
        "naturale, fai in modo che una di queste sia la risposta ovvia alla tua battuta.",
    "Regole:\n" +
      "- Parla solo polacco, come un madrelingua paziente: una o due frasi brevi, parole " +
      "comuni, grammatica semplice.\n" +
      "- Segui quello che dice lo studente, anche se esce dall'obiettivo.\n" +
      "- Non correggere mai i suoi errori e non commentare il suo polacco.\n" +
      "- Le sue battute vengono dal riconoscimento vocale: possono contenere parole " +
      "sbagliate o italiane. Se capisci cosa intende, rispondi. Se non lo capisci, " +
      "chiedi in modo semplice di ripetere.",
    "Campi della risposta:\n" +
      "- line: la tua battuta in polacco.\n" +
      "- italian: la traduzione italiana di line.\n" +
      "- understood: false se non hai capito cosa intendeva lo studente nella sua ultima " +
      "battuta, true altrimenti e per la battuta di apertura.\n" +
      "- stepsTicked: gli id dei passi che lo studente ha completato con la sua ultima " +
      "battuta: nessuno, uno o più di uno. Completa un passo solo ciò che dice lo " +
      "studente, non ciò che dici tu.\n" +
      "- hint: da 2 a 4 parole polacche chiave, in forma base, per la probabile prossima " +
      "battuta dello studente.\n" +
      "- modelLine: una frase polacca breve e completa che lo studente potrebbe dire come " +
      "prossima battuta.",
  ];
  return sections.filter(Boolean).join("\n\n");
}
