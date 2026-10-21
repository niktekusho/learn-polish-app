# Conversation turns call the LLM live, on one warm CLI session per Conversation

Every other LLM use in the app is precomputed or cached so no screen waits on a call. A
**Conversation** breaks that rule: each character turn is a live LLM call. A scripted scene
graph would train the learner to stay on rails that real Polish speakers don't follow, and
open conversation is the skill the app exists for. The quota cost of a daily habit of
8–15 calls per Conversation is accepted for that.

Each Conversation runs one `claude -p --input-format stream-json --output-format
stream-json` process that holds the scene's context; turns are JSON lines on stdin. It
keeps subscription billing (no API key), and a 2026-10-21 spike measured warm turns at
0.8–3.5s against 2.5–5.4s for a cold spawn per call. Each turn has a 30s timeout and one
retry; a crashed process respawns with the transcript replayed. Model and effort are env
knobs, chosen by benchmarking Haiku and Sonnet at low/medium/high effort.

## Considered options

- **Pre-generated scene, zero LLM at runtime:** one background call builds character
  lines, expected intents and repair lines; turns are matched by lemma sets. Cheapest and
  testable, but the scene cannot follow the learner. Rejected for that.
- **Pre-generated with a capped live fallback for off-script turns:** rejected with the
  above; most turns at sub-A1 would be judged "off-script" by a lemma matcher anyway.
- **Cold `claude -p` per turn:** today's pattern. Rejected: CLI startup adds 2–4s to every
  turn, on top of Whisper.
- **API provider fallback on slow turns:** rejected. Per-token billing; timeout and retry
  are enough.

## Consequences

- The **Hint** is a separate call with the transcript, never a message in the character's
  session, so the character never sees meta requests.
- The Goal, opening and **Debrief** are single calls outside the turn loop, where quality
  matters more than latency.
