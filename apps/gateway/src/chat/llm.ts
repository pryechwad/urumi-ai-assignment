// Provider adapters behind one small interface. The rest of the agent never sees a
// provider-specific message format.
export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: unknown;
}

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError: boolean };

export interface LlmResponse {
  text: string;
  toolCalls: ToolCallRequest[];
}

export interface LlmProvider {
  readonly label: string;
  complete(system: string, messages: AgentMessage[], tools: LlmTool[], signal: AbortSignal): Promise<LlmResponse>;
}

export class LlmError extends Error {}

/** Seconds the provider asked us to wait on a 429, from Retry-After or the error text ("try again in 22.1s"). */
function retryAfterSeconds(res: Response, text: string): number | undefined {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header;
  const m = /try again in ([\d.]+)\s*s/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, attempt = 0): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch (err) {
    const e = err as Error;
    throw new LlmError(e.name === "TimeoutError" || e.name === "AbortError" ? "The model did not respond in time" : `Could not reach the model provider: ${e.message}`);
  }
  const text = await res.text();
  // Free-tier rate limits (tokens per minute) clear within seconds: wait as asked and retry (max 3 times).
  const wait = res.status === 429 ? retryAfterSeconds(res, text) : undefined;
  if (wait !== undefined && wait <= 60 && attempt < 3) {
    await new Promise((r) => setTimeout(r, Math.ceil(wait * 1000) + 500));
    return postJson(url, headers, body, signal, attempt + 1);
  }
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? detail;
    } catch {
      /* keep raw */
    }
    throw new LlmError(`Model provider returned HTTP ${res.status}: ${detail}`);
  }
  return JSON.parse(text);
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparseable_arguments: raw.slice(0, 500) };
  }
}

/** Any OpenAI-compatible chat completions API: Groq, OpenAI, OpenRouter, Ollama, vLLM... */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly label: string;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.label = `${new URL(baseUrl).host} · ${model}`;
  }

  async complete(system: string, messages: AgentMessage[], tools: LlmTool[], signal: AbortSignal): Promise<LlmResponse> {
    const wire = [
      { role: "system", content: system },
      ...messages.map((m) => {
        if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
        if (m.role === "assistant" && m.toolCalls?.length) {
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
          };
        }
        return { role: m.role, content: m.content };
      }),
    ];
    const body = {
      model: this.model,
      messages: wire,
      temperature: 0.2,
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto", parallel_tool_calls: false }
        : {}),
    };
    const json = await postJson(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, { authorization: `Bearer ${this.apiKey}` }, body, signal);
    const msg = json?.choices?.[0]?.message ?? {};
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolCalls: (msg.tool_calls ?? []).map((c: { id: string; function: { name: string; arguments: unknown } }) => ({
        id: c.id,
        name: c.function.name,
        args: parseArgs(c.function.arguments),
      })),
    };
  }
}

/** Anthropic Messages API. */
export class AnthropicProvider implements LlmProvider {
  readonly label: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {
    this.label = `anthropic · ${model}`;
  }

  async complete(system: string, messages: AgentMessage[], tools: LlmTool[], signal: AbortSignal): Promise<LlmResponse> {
    // Anthropic wants tool results as user-role tool_result blocks, grouped per turn.
    const wire: Array<{ role: "user" | "assistant"; content: unknown }> = [];
    for (const m of messages) {
      if (m.role === "tool") {
        const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content, is_error: m.isError };
        const last = wire[wire.length - 1];
        if (last?.role === "user" && Array.isArray(last.content)) (last.content as unknown[]).push(block);
        else wire.push({ role: "user", content: [block] });
      } else if (m.role === "assistant") {
        const content: unknown[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
        wire.push({ role: "assistant", content });
      } else {
        wire.push({ role: "user", content: m.content });
      }
    }
    const json = await postJson(
      `${this.baseUrl}/v1/messages`,
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      {
        model: this.model,
        max_tokens: 2048,
        system,
        messages: wire,
        ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      },
      signal,
    );
    const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> = json?.content ?? [];
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
      toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id!, name: b.name!, args: b.input ?? {} })),
    };
  }
}
