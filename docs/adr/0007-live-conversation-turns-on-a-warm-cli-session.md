# Conversation turns call the LLM live, on one warm CLI session per Conversation

Elsewhere in the app an LLM wait happens once per item and is cached after it: a word's
**Gloss** on first tap, a text's **Comprehension check**. A **Conversation** waits on
every turn: each character turn is a live LLM call. A scripted scene
graph would train the learner to stay on rails that real Polish speakers don't follow, and
open conversation is the skill the app exists for. The quota cost of a daily habit of
8–15 calls per Conversation is accepted for that.

Each Conversation runs one `claude -p --input-format stream-json --output-format
stream-json` process that holds the scene's context; turns are JSON lines on stdin. It
keeps subscription billing (no API key), and a 2026-10-21 spike measured warm turns at
0.8–3.5s against 2.5–5.4s for a cold spawn per call. Each turn has a 30s timeout and one
retry; a crashed process respawns with the transcript replayed. Codex holds a session the
same way through `codex app-server`, which is experimental, so its CLI version is pinned. Model and effort are env
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

- Each character turn also returns the **Hint** and **Model line** for the learner's next
  turn, shown only on tap. No meta request reaches the character's session, and it is
  never told whether a Hint was used. The opening call returns the first pair.
- The Goal, opening and **Debrief** are single calls outside the turn loop, where quality
  matters more than latency.
