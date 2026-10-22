# UI Redesign

Status: designed 2026-10-22 (grilling session + mood board). Terms per [CONTEXT.md](../CONTEXT.md).

Every screen gets a new look. The goal is looks only: no behavior changes inside the
redesign. Speech recognition and content parsing problems are out of scope; anything found
along the way becomes an issue.

## Devices and layouts

- **Phone-first**: OnePlus 8T, Firefox on Android, default font size. Practice, Reader,
  Story, Recap and Conversation are designed for the phone. Import is designed for the Mac.
  Maintenance works on both.
- **Two layouts**, switched by width:
  - **Narrow** (portrait phone): bottom sheets, bottom-anchored actions.
  - **Wide** (landscape phone and Mac): side panels instead of sheets, actions beside the
    content, compact top bar.
- **Prototype frames**: portrait 412×860, landscape 915×360 (Firefox toolbar subtracted),
  desktop. Every prototype shows all three.
- **Light mode only.** Colors are named tokens, so dark mode stays a later token swap.

## Style

Settled by the mood board ([artifact](https://claude.ai/artifact/HyaAT55RM7TF3PJyXHoM8a),
reactions in its `reactions` collection):

- **Fonts follow purpose, not language.** All prose, Polish or Italian (glosses,
  explanations included), is set in **Literata**. A sans is for UI chrome only: buttons,
  labels, counts. The UI sans is chosen in the style round (Inter, Nunito, Outfit or system).
- **Reading size**: 18px default, with a per-device setting (16px also liked).
- **Reader background**: faint paper `#F6F1E8`. Other pages may use other colors.
- **Navigation**: hub only. Home is the start of the daily path; each finished step leads to
  the next. Import and Maintenance move to a small menu on Home.
- **Icons**: line icons (`lucide-react`, already installed).
- **Done state**: quiet.
- **Taste**: generous color in medium doses, sturdy serifs, soft springy motion. Avoid what
  reads as thin, plain or clinical, gamey (3D buttons, full-width color bands, streak tiles)
  or noisy (case tags under words).
- **Detailed screens stay detailed**: the WordPanel keeps all its current content.
  Progressive disclosure is fine, a reduced panel is not.

### Color

Color is both semantic and decorative:

- **Word state** in the Reader: new, still learning and known, plus Expressions and Names.
  Fading boxes vs ink-only color is decided in the style round.
- **Knowledge tracks**: Receptive, Productive and Pronunciation each get a bold hue that also
  serves as decorative section color. Whether track hues are the section colors is decided
  in the style round. Not as full-width header bands.
- **Cases**: solid pills, only where a case is already displayed (WordPanel *Forme* list,
  Name panel). Coloring endings in Reader text and an inflection table are out of scope.
  Tracked in issue #9.

### Accessibility

- WCAG AA text contrast (4.5:1), including text on track-hue fills.
- Touch targets of at least 44px: short Polish words in the Reader need padding.
- Hue alone may carry meaning (single user, typical color vision).

## Copy

All UI copy is Italian (CONTEXT.md **L1**). The table below is the default copy for
prototypes. Each screen's labels are settled in its prototype review; a label lands in
CONTEXT.md ("Shown in the UI as _x_") only when its screen ships.

| Term or string | Label |
|---|---|
| Practice | Pratica |
| Retry | Ancora una volta |
| Report | Segnala (*Significato sbagliato* / *Serve il contesto*) |
| Report review | Segnalazioni riviste |
| Context-bound lemma | Serve il contesto |
| Story / Episode | Storia / Episodio |
| Conversation | Conversazione |
| Goal | Obiettivo |
| Hint | Suggerimento |
| Model line | Frase pronta |
| Debrief | Com'è andata (title), Correzioni (list) |
| Heard line | battute ascoltate |
| Mature | consolidata |
| Comprehension check | Verifica comprensione |
| Read-aloud | Leggi ad alta voce |
| Spoken recall | Dillo in polacco |
| Passage exercise | Brano |
| Recognition exercise | Riconosci |
| Gloss / Manual gloss | Traduzione / Traduzione tua |
| Occurrence gloss | In questa frase |
| Lemma | Forma base |
| Name | Nome proprio |
| Formula / Multi-word expression | Formula / Espressione |
| Suppressed MWE / formula | Espressione ignorata / Formula ignorata |
| Home dictionary | Dizionario |
| Learner profile | Il tuo profilo |
| Character memory | no label (never shown) |
| App title | Impara il polacco |
| Import text / Maintenance | Importa testo / Manutenzione |
| "312 tokens" | 312 parole |
| Paste some Polish text first. | Innanzitutto, incolla un testo in polacco. |
| Nothing due right now. | Niente da ripassare ora. |
| Session complete | Sessione completata |
| Hold to speak / Release to send | Tieni premuto per parlare / Rilascia per inviare |
| Transcribing… | Trascrivo… |
| Mic on / off | icon toggle (`Mic` / `MicOff`), text as `aria-label` only |
| Listen / Next / Finish / Close | Ascolta / Avanti / Fine / Chiudi |
| Part of speech / Sentence | Categoria grammaticale / Frase |

Maintenance's operation labels are translated in its own prototype.

## Process

1. **Mood board**: done 2026-10-22.
2. **Style round**: 3 variants of Home and Reader (WordPanel open) on one Artifact page. The
   variants differ in UI sans, word-state treatment, track colors as section colors or not,
   and Home background, accent, radius and shadow. Structure stays the same so only style is
   judged. Output: a token summary.
3. **Tokens PR**: an `@theme` block in `app/src/styles.css` (colors, type scale, spacing,
   radius) and fonts self-hosted in `app/public/fonts` with `@font-face`, no new dependency.
4. **One screen at a time**, in this order: Reader + WordPanel → Practice → Home + Recap →
   Story → Conversation → Import → Maintenance. Per screen: prototype → review → one PR →
   check on the phone → `polish` skill pass → merge. Merging to `main` deploys (ADR-0006),
   so each screen is in daily use before the next is designed.
   Home's track-color layout and the WordPanel layout get their final design in their own
   screen sessions.

No component library. A shared component (`Button`, `Card`, `Chip`, `BottomSheet`) is
extracted only when a second screen needs it.

### Prototypes

- Private Artifact pages, throwaway. Nothing is committed except the Conversation spec.
- **Real content only**, no lorem ipsum: from a snapshot of the prod DB taken with
  `sqlite3 ~/Library/Application\ Support/learn-polish/app.db ".backup <scratch>/snapshot.db"`.
  The prod DB is never opened any other way.
- Static HTML, clickable where it matters (tap a word, answer an item).

### Conversation spec

Conversation has no screen yet (Slice 0.6). Its prototype becomes the spec for Slice 0.6
step 3:

- `docs/prototypes/conversation.html`: the approved prototype, written with the real token
  names.
- `docs/prototypes/conversation/*.png`: one screenshot per screen state, portrait and
  landscape, taken from that HTML. They are the acceptance target.
- A UI section in `docs/slice-0.6-spec.md`: the HTML is the visual reference (port layout
  and classes, not its script), the list of states and what triggers each, and where each
  piece of fake data comes from.
