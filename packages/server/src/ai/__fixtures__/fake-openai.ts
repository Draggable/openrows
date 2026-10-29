import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake OpenAI-compatible server for tests (#148): `POST <prefix>/chat/completions` answers
 * what `respond` returns (by default a completion echoing a JSON object), and every request is
 * kept (headers and parsed body) so tests can check what was sent.
 */

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** An object is sent as JSON; a string as is. */
  body: unknown;
}

export interface FakeOpenAi {
  /** `http://127.0.0.1:<port>/v1` */
  baseUrl: string;
  port: number;
  requests: FakeRequest[];
  respond: (req: FakeRequest) => FakeReply;
  close(): Promise<void>;
}

/** A chat completion answering `content`, with usage. */
export function completion(
  content: string | null,
  extra: { finishReason?: string; usage?: unknown; refusal?: string; model?: string } = {}
): FakeReply {
  return {
    body: {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      model: extra.model ?? 'fake-model-2026',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, refusal: extra.refusal ?? null },
          finish_reason: extra.finishReason ?? 'stop',
        },
      ],
      usage:
        extra.usage === undefined
          ? { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }
          : extra.usage,
    },
  };
}

export async function startFakeOpenAi(prefix = '/v1'): Promise<FakeOpenAi> {
  const requests: FakeRequest[] = [];
  const fake: Partial<FakeOpenAi> & { requests: FakeRequest[] } = {
    requests,
    respond: () => completion('{"ok":true}'),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        // Kept empty: the test sees it.
      }
      const path = req.url ?? '/';
      const request: FakeRequest = {
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        body,
      };
      requests.push(request);
      const reply =
        path === `${prefix}/chat/completions` && req.method === 'POST'
          ? (fake.respond as FakeOpenAi['respond'])(request)
          : {
              status: 404,
              body: { error: { message: 'no route', type: 'invalid_request_error' } },
            };
      const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(text);
    });
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  );
  fake.port = port;
  fake.baseUrl = `http://127.0.0.1:${port}${prefix}`;
  fake.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return fake as FakeOpenAi;
}

/** The outbound rules that let the SSRF-safe client reach the fake. */
export function fakeOutbound(port: number) {
  return { allowHttp: true, extraPorts: [port], allow: ['127.0.0.1'], deny: [] };
}
