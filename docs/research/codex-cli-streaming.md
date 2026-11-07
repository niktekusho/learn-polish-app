# Codex CLI warm sessions

Researched 2026-11-07 against `codex-cli 0.166.0` (tag `rust-v0.166.0` of openai/codex).

## Conclusion

Yes. `codex app-server` runs as one long-lived process that takes many turns over stdin/stdout as newline-delimited JSON-RPC, and it works with the ChatGPT-subscription login. A local smoke test held context across two turns in one process: after a one-time startup of about 2.6s, turns took 3.9s and 1.8s, compared with 8.3 to 9.6s for each cold `codex exec`. The recommended mode is `codex app-server` with one thread per Conversation. The main risk is that the CLI labels `app-server` "[experimental]" and the protocol changes fast, so pin the CLI version and generate the types from the installed binary.

## 1. Modes that could serve multiple turns

**`codex app-server` fits.** It is present in 0.166.0 and labelled "[experimental] Run the app server or related tooling" in `codex --help`. The default transport is `--listen stdio://` (`codex app-server --help`). The official docs describe it as "the interface Codex uses to power rich clients". On stdio, messages are "newline-delimited JSON (JSONL)" using JSON-RPC 2.0 with the `"jsonrpc":"2.0"` header left out (Codex App Server docs). The docs mark the WebSocket transport and methods behind `experimentalApi` as experimental. The basic thread and turn methods need no opt-in, and the smoke test ran them without it.

The protocol, confirmed with `codex app-server generate-ts --out <dir>` on 0.166.0:

- The client sends an `initialize` request with `{clientInfo, capabilities}`, then an `initialized` notification. The docs say any other request sent before this gets `Not initialized`.
- `thread/start` takes `model`, `cwd`, `approvalPolicy`, `sandbox`, `config`, `baseInstructions`, `developerInstructions` and `ephemeral` (`v2/ThreadStartParams.ts`). The response carries `thread.id` and the resolved `model`.
- A user turn is `turn/start` with `{threadId, input: [{type: "text", text, text_elements: []}]}`. It also accepts `model`, `effort`, `sandboxPolicy`, `approvalPolicy` and `outputSchema`, and these overrides apply "for this turn and subsequent turns" (`v2/TurnStartParams.ts`).
- The final reply is an `item/completed` notification whose `item.type` is `"agentMessage"` with a `text` field (`v2/ThreadItem.ts`). The `item/agentMessage/delta` notification streams partial text.
- Turn completion is the `turn/completed` notification. Its `turn.status` is one of `completed`, `interrupted`, `failed` or `inProgress` (`v2/TurnStatus.ts`). The docs say the server emits it "when the model finishes or after a `turn/interrupt` cancellation".
- The server can also send its own JSON-RPC requests, such as approvals (`ServerRequest.ts`). With `approvalPolicy: "never"` and a read-only sandbox, the smoke test received none, but the client should still reply to or fail any request it gets.

OpenAI's own Python SDK drives `codex app-server --listen stdio://` as a "typed JSON-RPC client for `codex app-server` over stdio" (`sdk/python/src/openai_codex/client.py`, lines 215 and 256 at the tag). It is the first-party multi-turn client.

**`codex exec --json` does not fit.** It is stable and prints JSONL events (`thread.started`, `item.completed` with `type: "agent_message"`, `turn.completed` with token usage), but it runs a single turn and exits. Stdin supplies only the initial prompt (`codex exec --help`). The TypeScript SDK wraps it and spawns a new `exec` (with `resume <threadId>` on later turns) per turn (`sdk/typescript/src/exec.ts`, lines 95, 174 and 203), so that SDK is cold per turn too.

**`codex mcp-server` and `codex proto` are gone.** Neither is a subcommand in 0.166.0: both strings fall through to the interactive CLI's prompt argument, and `codex --help` lists neither. `codex mcp` only manages external MCP servers (`list/get/add/remove/login/logout`). The source tree at the tag has no MCP-server crate. I could not find the commit that removed them.

**`codex exec resume <id>` is a cold fallback.** See section 4.

## 2. ChatGPT-subscription login

`codex login status` reports "Logged in using ChatGPT". In the smoke test, `account/read` over app-server returned `account.type: "chatgpt"` with `planType: "plus"`, and both turns ran without an API key. `codex exec` and `exec resume` used the same login. The docs page I read does not describe auth modes, so this claim rests on the local test and the `account/*` methods in the generated bindings.

## 3. Stripping tools, and setting model, effort and instructions

No single flag removes every tool the way claude's `--tools ""` does. The closest setup:

- `sandbox: "read-only"` and `approvalPolicy: "never"` on `thread/start`. Per `codex --help`, "never" means execution failures "are immediately returned to the model".
- `web_search = "disabled"` ("Controls the web search tool mode: disabled, cached, indexed, or live", `codex-rs/core/config.schema.json`).
- Turning off the tool feature flags listed by `codex features list` with `--disable <feature>`, which is equivalent to `-c features.<name>=false` (`codex --help`). These flags are on by default: `shell_tool`, `unified_exec`, `apps`, `plugins`, `multi_agent`, `view_image`, `image_generation`, `browser_use`, `computer_use`, `goals`, `sleep_tool`, `tool_suggest`, `skill_search`.

Measured with `codex exec --json`, disabling those flags cut input tokens for a trivial prompt from 20,146 to 12,829, and wall time from about 9s to 6.1s. The remaining tokens are presumably Codex's built-in instructions. `app-server` accepts the same `-c`/`--disable` flags at launch (`codex app-server --help`). I did not test whether `thread/start.config` accepts feature overrides per thread.

Model and effort: `thread/start.model` sets the model per thread, and `turn/start.effort` sets reasoning effort (sticky for later turns). The config key is `model_reasoning_effort`. The default model the smoke test reported was `gpt-5.6-terra`.

Instructions: `developerInstructions` on `thread/start` is "inserted as a `developer` role message" (schema description of `developer_instructions`). In the smoke test the model followed a developer instruction to reply in one short sentence as a barista. `baseInstructions` replaces the built-in system prompt. The schema says users are "STRONGLY DISCOURAGED" from overriding it (`model_instructions_file`), and I did not test it.

## 4. `codex exec resume` as a fallback

It works but costs as much as a cold call. `codex exec resume --json <id> "<prompt>"` recalled the previous turn in 9.6s wall time. It reported 40,312 input tokens (27,136 cached) against 20,146 for the first turn, so each resume replays the whole thread. It needs a persisted session, which rules out `--ephemeral`, and leaves session files to delete with `codex delete --force <id>`. It is slower than today's one-shot `codex exec` and offers no latency gain, only a shared context.

## 5. Local measurements

All runs used an empty scratch directory and the logged-in ChatGPT account, with no config changes. The test session that `exec` persisted was deleted afterwards.

| Call | Wall time |
|---|---|
| `app-server` spawn to `initialize` reply | 0.35s |
| `account/read` + `thread/start` (ephemeral) | 2.25s more |
| app-server turn 1 ("say ciao in Polish") | 3.9s |
| app-server turn 2 (recall turn 1) | 1.8s |
| cold `codex exec`, default tools, effort low | 8.3s, 9.6s, 13.1s |
| cold `codex exec`, tool flags disabled | 6.1s |
| `codex exec resume`, turn 2 | 9.6s |

These are single samples, and model latency varies from call to call. Still, the warm turns ran 2 to 5 times faster than any cold call.

## Unverified

- Whether `thread/start.config` accepts `features.*` and `web_search` overrides per thread, as opposed to process-level `-c` flags.
- The commit or release that removed `mcp-server` and `proto`.
- Long-session behaviour: compaction, idle timeouts, token refresh in a process that stays open for a whole Conversation.
- Whether the shared `app-server daemon` (`codex app-server daemon`, feature `daemon_auto_start`) changes anything for a plain stdio child process.

## Sources

- Local help output for `codex-cli 0.166.0`: `codex --help`, `codex app-server --help`, `codex exec --help`, `codex exec resume --help`, `codex mcp --help`, `codex features list`, `codex login status`.
- Protocol types generated locally with `codex app-server generate-ts` (0.166.0): `v2/ThreadStartParams.ts`, `v2/TurnStartParams.ts`, `v2/ThreadItem.ts`, `v2/TurnStatus.ts`, `ClientRequest.ts`, `ServerNotification.ts`.
- Codex App Server docs: https://developers.openai.com/codex/app-server (redirects to https://learn.chatgpt.com/docs/app-server).
- openai/codex at tag `rust-v0.166.0`: `codex-rs/core/config.schema.json`, `codex-rs/app-server/README.md`, `sdk/python/src/openai_codex/client.py`, `sdk/typescript/src/exec.ts`, and the source tree listing.
- Smoke test script (not in the repo): a Node script that spawns `codex app-server` and runs `initialize`, `account/read`, `thread/start` and two `turn/start` calls.
