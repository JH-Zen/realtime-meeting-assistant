import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local OpenAI-compatible Chat Completions endpoint, used so the adapter can be tested against
 * the real wire (chunked SSE, HTTP status codes, SDK retry semantics) without an API key.
 * Test-only: production selects either the mock provider or a configured remote endpoint.
 */

export interface StubReply {
  /** Default 200. */
  status?: number;
  /** Assistant text for a non-stream response; ignored when `deltas` is set. */
  content?: string;
  /** Sent as `delta.content` chunks for a streaming request. */
  deltas?: string[];
  promptTokens?: number;
  completionTokens?: number;
}

export interface RecordedRequest {
  body: {
    model?: string;
    stream?: boolean;
    response_format?: unknown;
    /** Vendor-specific: sent only while `LLM_DISABLE_THINKING` is on. */
    enable_thinking?: boolean;
    messages: { role: string; content: string }[];
  };
}

export interface LlmStub {
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startLlmStub(replies: StubReply[]): Promise<LlmStub> {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const server: Server = createServer((req, res) => {
    const raw: Buffer[] = [];
    req.on("data", (chunk: Buffer) => raw.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(raw).toString("utf8"));
      requests.push({ body });
      // The last reply repeats: a test needing "always invalid" must not run out of responses.
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;

      if ((reply.status ?? 200) !== 200) {
        res.writeHead(reply.status ?? 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub failure", type: "server_error" } }));
        return;
      }

      if (body.stream === true && reply.deltas) {
        res.writeHead(200, { "content-type": "text/event-stream", "transfer-encoding": "chunked" });
        for (const delta of reply.deltas) {
          res.write(`data: ${JSON.stringify({ id: "stub", choices: [{ index: 0, delta: { content: delta } }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `stub-${index}`,
          object: "chat.completion",
          model: body.model ?? "stub-model",
          choices: [{ index: 0, message: { role: "assistant", content: reply.content ?? "" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: reply.promptTokens ?? 100,
            completion_tokens: reply.completionTokens ?? 40,
            total_tokens: (reply.promptTokens ?? 100) + (reply.completionTokens ?? 40),
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
