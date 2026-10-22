# Project rules

Read [CONTEXT.md](./CONTEXT.md) for the domain language and [docs/adr/](./docs/adr/) for past decisions.

## Deterministic first

When data or code can decide something (the **Home dictionary**, morphology, a rule), do not ask an LLM. LLM calls are for what has no deterministic answer, and their output is checked against deterministic data where possible: an LLM picks a dictionary sense key rather than writing Italian, and the key is validated before it is stored.
