// The HTTP server: one process serving git smart HTTP, REST v3, GraphQL and MCP from one store.
// Every reply is JSON with a request id; auth is the trial's bearer token on every surface but /healthz.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest } from './rest.ts';
import { handleGit } from './gitsmart.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let requestCounter = 0;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': 0 });
  res.end();
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry.local');
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    path = url.pathname;
  }
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (req.headers.authorization !== `Bearer ${token}`) {
    throw new HttpError(401, 'Bad credentials');
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') throw new HttpError(404, 'Not Found');
    await handleGraphql(req, res);
    return;
  }
  if (path === '/mcp') {
    if (method !== 'POST') throw new HttpError(404, 'Not Found');
    await handleMcp(req, res);
    return;
  }

  const git = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (git !== null) {
    await handleGit(req, res, git[1], git[2], git[3] ?? '', url, method);
    return;
  }

  if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
    const sub = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
    await handleRest(req, res, sub, url, method);
    return;
  }

  throw new HttpError(404, 'Not Found');
}

export function createApp(): Server {
  return createServer((req, res) => {
    requestCounter += 1;
    res.setHeader('x-github-request-id', `forge-${requestCounter.toString(16).padStart(8, '0')}`);
    route(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) {
        sendJson(res, status, { message });
      } else {
        res.end();
      }
    });
  });
}