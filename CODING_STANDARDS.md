# Coding standards

Read during review. Tooling already enforces formatting (`vp fmt`), lint (`vp lint`), types
(`pnpm --filter app typecheck`), and counted words going through `plural()`
(`scripts/check-plural.sh`). Review what tooling cannot see.

## Sources

- [AGENTS.md](./AGENTS.md): deterministic first. An LLM call needs a case no data or rule
  decides, and its output is validated against deterministic data before it is stored.
- [CONTEXT.md](./CONTEXT.md): domain terms. Code and UI copy use the glossary term. A screen
  that ships records how each glossary term it shows appears, as "Shown in the UI as _x_".
  CONTEXT.md is a glossary: other UI copy (buttons, headings) lives only in the code.
- [docs/ui-redesign.md](./docs/ui-redesign.md): tokens, type scale, spacing, copy and
  accessibility for every screen. Colors come from `@theme` tokens.
- [docs/adr/](./docs/adr/): decisions a change must keep or explicitly supersede.

## Judgement rules

- **Touch targets.** Every tappable element is at least 44px tall, a link inside prose
  included: make it a button or pad it to 44px.
- **Row order.** When a result depends on which row comes first or last, the query has an
  explicit `orderBy`. Without it the order is whatever index SQLite picks, and a test with
  a few rows rarely shows the difference.
- **Per-track data.** Presentation per Knowledge track (name, colors, glow) lives on `TRACK`
  in `app/src/ui.tsx`, one map for every screen.
