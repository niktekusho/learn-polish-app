# Claude CLI stream-json sessions

Checked 2026-11-07 against `claude` 2.1.319, with `claude-haiku-5-5`.

## Conclusion

`claude -p --input-format stream-json --output-format stream-json --verbose` holds one process across many turns. The client writes one JSON user message per line to stdin. For each message the CLI prints events and ends with one `result` event. `ClaudeSession` (`app/src/llm/claude-session.ts`) reads the reply from that `result` event.

## Facts

- `--verbose` is required with `--output-format stream-json`. Without it the CLI exits with "When using --print, --output-format=stream-json requires --verbose".
- stdin message: `{"type":"user","message":{"role":"user","content":"<text>"}}`, one per line.
- stdout events seen for one turn, in order: `system` (subtype `init`), `assistant`, `user` (the tool result of the schema tool), `rate_limit_event`, `result`. Only `result` ends the turn; skip the rest.
- With `--json-schema` the model answers through a `StructuredOutput` tool call. The `result` event then has `result` (the reply as a JSON string) and `structured_output` (the same value, parsed). The code parses `result`, so the one-shot `readClaudeReply` serves both paths.
- Usage fields of the `result` event match the one-shot JSON: `usage.input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, plus `duration_api_ms`.
- A failed turn has `is_error: true` and a `subtype` such as `error_during_execution`.

## Probing

macOS has no `timeout` command. Write a probe's output to a file once and read the file, since the `result` event comes last and is long: `... > "$SCRATCH/out.txt"`.
