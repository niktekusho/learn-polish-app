import type { CallOptions, CallSpec, Llm, ProviderName } from "./call";

export interface FakeCall {
  name: string;
  req: unknown;
  options?: CallOptions;
}

export type FakeLlm = Llm & { calls: FakeCall[] };

/** The calls a fake received for one spec, by spec name. */
export const callsNamed = (llm: FakeLlm, name: string) => llm.calls.filter((c) => c.name === name);

/**
 * Test double for `Llm`. `answers` replaces a spec's stub by spec name. `fails` is one
 * queue shared by every call: each call takes one entry, and a non-null entry throws.
 */
export function fakeLlm(
  options: {
    name?: ProviderName;
    answers?: Record<string, (req: any) => unknown>;
    fails?: (Error | null)[];
  } = {},
): FakeLlm {
  const calls: FakeCall[] = [];
  const fails = [...(options.fails ?? [])];
  return {
    name: options.name ?? "stub",
    calls,
    async call<Req, Res>(spec: CallSpec<Req, Res>, req: Req, callOptions?: CallOptions) {
      calls.push(
        callOptions ? { name: spec.name, req, options: callOptions } : { name: spec.name, req },
      );
      const fail = fails.shift();
      if (fail) throw fail;
      const answer = options.answers?.[spec.name];
      return answer ? (answer(req) as Res) : spec.stub(req);
    },
  };
}
