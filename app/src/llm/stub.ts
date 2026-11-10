import type { CallSpec, Llm, ProviderName } from "./call";

// Deterministic, offline stand-in for a real LLM, so the app runs without any
// network or API key. A call answers with its spec's stub.
export class StubProvider implements Llm {
  readonly name: ProviderName = "stub";

  async call<Req, Res>(spec: CallSpec<Req, Res>, req: Req): Promise<Res> {
    return spec.stub(req);
  }
}
