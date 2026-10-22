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
  labels, counts. The UI sans is **Inter**, chosen in the style round for readability.
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
  The mark fades with familiarity: new in a box, still learning in ink only, known plain.
- **Knowledge tracks**: Receptive, Productive and Pronunciation each get a bold hue that also
  serves as decorative section color: a hue dot, with the track name and number in the
  track's ink, on a neutral surface. Not as full-width header bands.
- **Cases**: solid pills, only where a case is already displayed (WordPanel *Forme* list,
  Name panel). Coloring endings in Reader text and an inflection table are out of scope.
  Part of issue #12.

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

## Tokens

Settled by the style round. Light mode only: dark mode is a later swap of these values.
Every text pair below meets WCAG AA (contrast ratios in parentheses).

### Colors

| Token | Value | Role |
|---|---|---|
| `paper` | `#F6F1E8` | Reader and Home background |
| `card` | `#FFFCF6` | Cards on Home |
| `panel` | `#FFFDF9` | WordPanel, bottom sheet, side panel |
| `rule` | `#E3DBCC` | Dividers on paper and panel |
| `ink` | `#28241E` | Body text (13.7:1 on paper) |
| `ink-2` | `#575046` | Secondary text, meta lines (7.1:1) |
| `ink-3` | `#6E6659` | Labels, captions, counts (5.0:1) |
| `accent` | `#3A45B8` | Primary buttons, selection outline, links (white on it 7.7:1) |
| `accent-soft` | `#E3E6FA` | Translation box, chips, done tick, count badges |
| `accent-ink` | `#2C3591` | Accent text on `accent-soft` (8.4:1) or `panel` |
| `receptive` / `-soft` / `-ink` | `#2457C5` / `#E3EAFA` / `#1B428F` | Receptive track: dot / tint / name and number (9.2:1 on card) |
| `productive` / `-soft` / `-ink` | `#C2410C` / `#FCE9DC` / `#8F300A` | Productive track (ink 7.9:1); the hue also colors the streak flame |
| `pronunciation` / `-soft` / `-ink` | `#7A35D6` / `#EFE6FC` / `#5A24A3` | Pronunciation track (ink 9.3:1) |
| `word-new` | `#F6D36C` | Box behind a new word (`ink` on it 10.6:1) |
| `word-learning` | `#7A5800` | Ink of a still-learning word, no box (5.8:1) |
| `word-mwe` | `#2F6DB5` | Dotted 2px underline under an Expression, offset 0.3em |
| `word-name` | `#6B3F78` | Ink of a tappable Name (7.2:1) |
| `case-nom` … `case-voc` | `#4B5563` `#B4235A` `#B45309` `#1D6FA5` `#6D28D9` `#0F766E` `#9F1239` | Solid case pills, white text (nom, gen, dat, acc, ins, loc, voc; lowest 5.0:1) |

A known word has no mark. The selected word gets a 2px `accent` outline. The `-soft` track
tints stay unused on Home (neutral rows won the round), so they are kept only if a later
screen needs them.

### Type

Literata for all prose, Inter for UI chrome. Prose sizes follow the per-device reading
setting (18px default, 16px option); UI sizes are fixed.

| Step | Size / line height | Use |
|---|---|---|
| `xs` | 12.5px / 1.4 | Uppercase labels (600, letter-spacing 0.06–0.08em), case pills, tags |
| `sm` | 13.5px / 1.4 | Meta lines, captions, small actions |
| `base` | 15px / 1.45 | UI body, buttons (600) |
| `md` | 17px / 1.3 | Step labels on Home (600) |
| `prose` | 18px / 1.85 | Reader text (Literata) |
| `lg` | 21px / 1.3 | Translation in the WordPanel (Literata 600) |
| `xl` | 24px / 1.25 | Reader title (Literata 700) |
| `2xl` | 28px / 1.15 | Word in the WordPanel, Home title (Literata 700); track numbers (Inter 700, tabular) |

Weights: Literata 400, 600, 700 and italic 400; Inter 400, 500, 600, 700.

### Spacing

4px steps: `1` 4, `2` 8, `3` 12, `4` 16, `5` 20, `6` 24, `8` 32. Screen gutter 16px on the
phone, 20–28px wide. Every touch target is at least 44px; Reader words pad vertically to
fill the line box.

### Radius

| Token | Value | Use |
|---|---|---|
| `radius` | 10px | Buttons, inputs, translation box, menus |
| `radius-lg` | 20px | Cards, the sheet's top corners |
| `radius-word` | 3px | Box behind a new word |
| `radius-full` | 9999px | Chips, count badges, case pills, done tick |

Cards are rounder than the controls inside them on purpose: an outer radius near the inner
radius plus the padding keeps nested corners even.

### Shadow

| Token | Value | Use |
|---|---|---|
| `shadow-card` | `0 12px 30px -10px rgb(40 30 60 / .28), 0 2px 6px rgb(40 30 60 / .06)` | Cards on Home |
| `shadow-sheet` | `0 -14px 40px -8px rgb(40 30 60 / .30)` | Bottom sheet |
| `shadow-button` | `0 2px 6px -2px` `accent` at 60% | Primary button |

Cards carry no border.

### Fonts to self-host

In `app/public/fonts`, each with its `OFL.txt` (both SIL Open Font License 1.1). Variable
files, not subset: Polish needs Latin Extended-A and the WordPanel shows IPA.

| File | Source | Axes |
|---|---|---|
| `literata.woff2` | Literata roman variable TTF from [googlefonts/literata](https://github.com/googlefonts/literata), compressed once to woff2 (`fonttools ttLib.woff2 compress`) | `opsz` 7–72, `wght` 200–900 |
| `literata-italic.woff2` | Literata italic variable TTF, same repository and conversion | `opsz` 7–72, `wght` 200–900 |
| `inter.woff2` | `InterVariable.woff2`, [rsms/inter](https://github.com/rsms/inter) v4 | `opsz` 14–32, `wght` 100–900 |

Fallback stacks: `Literata, Georgia, serif` and `Inter, system-ui, sans-serif`.

## Process

1. **Mood board**: done 2026-10-22. Steps 2–4 are issues #10–#18, a linear chain.
2. **Style round**: done 2026-10-22 ([issue #10](https://github.com/niktekusho/learn-polish-app/issues/10),
   [artifact](https://claude.ai/artifact/2DKFyWWxejx6YtyNLi5zpK), picks in its `picks/main`
   document). 3 variants of Home and Reader (WordPanel open), then per-element options.
   Output: [Tokens](#tokens).
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
