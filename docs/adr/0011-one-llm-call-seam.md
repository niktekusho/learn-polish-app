# Every LLM call goes through one `call(spec, req)` seam

The LLM module in `app/src/llm/` has one interface, `Llm`, with one method: `call(spec, req, options?)`. A `CallSpec` names the call for the call log, picks its model tier, builds the prompt, parses the reply and gives the stub result. Each spec is a `const` in the `llm.ts` of the feature folder that makes the call (`gloss/llm.ts` holds `sentenceGloss`, `senseGloss` and `occurrenceGloss`), with its request and result types beside it and its prompt and parser tests in `llm.test.ts`. The module keeps what every call shares: model tiers from env, timing, the call log, fence stripping, JSON parsing and error wrapping.

Before this, each of the 14 calls was a method on a per-feature interface (`GlossProvider`, `StoryProvider`, `SceneProvider` and smaller ones), implemented once in the CLI adapter and once in the stub. A new call touched `llm/provider.ts`, `llm/cli.ts`, `llm/stub.ts` and a union of call names. Features that took a narrow interface checked whether the adapter they were handed had a method, and fell back when it did not.

Every adapter answers every spec, so no caller checks for a capability. The CLI adapter (`CliProvider`, with `ClaudeCliProvider` and `CodexCliProvider` as subclasses) runs `spec.prompt` and `spec.parse` around its exec; the stub adapter (`StubProvider`) returns `spec.stub(req)`. A spec carries its own stub, so a new call touches one file in its feature folder.

The stub sits at the call seam, not at the exec seam, because it has to read the request: a sense gloss stub translates as many senses as the request lists, an MWE check stub answers each item it was sent, and a scene stub returns one voice per character from the catalog it was sent. The stub scene opens the same bakery script `ScriptedSession` plays, so offline dev runs one coherent Conversation.

## Considered options

- **A stub at the exec seam that returns canned CLI text**: the CLI adapter would parse it like a real reply, but the stub would have to write text in each of the 14 prompt formats and keep it in step with every prompt change.
- **One stub in `llm/` that switches on a closed union of call names**: one place for every offline result, but every new call would touch `llm/` again, which is the coupling this decision removes.

## Consequences

- Tests use one fake, `fakeLlm` in `llm/fake.ts`: it answers with each spec's stub unless a test overrides that spec by name, and records every call, so a test asserts on the calls it cares about by name.
- A Conversation turn is not a spec: the warm session of ADR-0007 keeps its own interface. It shares the CLI adapter's helper that times a call, reads the reply, parses it and logs it, so a turn reply gets the same fence stripping as every other call.
- `GLOSS_PROVIDER` still picks the adapter for every call, and `appLlm()` in `llm/index.ts` returns it.
