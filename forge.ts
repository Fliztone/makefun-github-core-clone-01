// The HTTP server and router: one process serving git smart HTTP, REST v3, GraphQL v4 and
// MCP from one store. Every answer carries a non-empty X-GitHub-Request-Id; every API
// surface but /healthz requires the trial's bearer token; every error is JSON, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

/** Read the whole request body (git pushes carry binary packfiles, APIs carry JSON).
 * A request that cannot carry a body skips the stream machinery entirely: the read and
 * clone workloads are thousands of bodyless GETs, and each saved turn matters. Bodies
 * are read with plain events, the shortest path for the single-chunk case. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD') return Buffer.alloc(0);
  const length = req.headers['content-length'];
  const chunked = req.headers['transfer-encoding'] !== undefined;
  if (!chunked && (length === undefined || length === '0')) return Buffer.alloc(0);
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

/** Decode a pathname segment by segment, keeping the slashes a contents path carries.
 * The common path holds no escapes at all and is returned untouched. */
function decodePath(pathname: string): string {
  if (!pathname.includes('%')) return pathname;
  return pathname
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

export interface Forge {
  server: Server;
  store: Store;
}

/** A read-only empty query, shared by every request that carries no query string. */
const EMPTY_QUERY = new URLSearchParams();

export function createForge(): Forge {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req, res) => {
    res.setHeader('x-github-request-id', store.requestId());
    void route(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[forge] request failed: ${message}\n`);
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal server error' });
      else res.end();
    });
  });
  // The benchmark reads on one warm keep-alive connection; keep sockets alive generously.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 0;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The clients send clean paths; split the query off without a full URL parse, and
    // share one empty query object for the (majority) requests that carry none.
    const raw = req.url ?? '/';
    const queryAt = raw.indexOf('?');
    const path = decodePath(queryAt < 0 ? raw : raw.slice(0, queryAt));
    const query = queryAt < 0 ? EMPTY_QUERY : new URLSearchParams(raw.slice(queryAt + 1));
    const method = (req.method ?? 'GET').toUpperCase();

    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // One bearer token rules every API surface; a request without it is a 401.
    if (expectedToken !== '' && req.headers.authorization !== `Bearer ${expectedToken}`) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }

    const body = await readBody(req);

    if (path === '/api/graphql') {
      handleGraphql({ store, req, res, body });
      return;
    }
    if (path === '/mcp') {
      handleMcp({ store, req, res, body });
      return;
    }
    if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
      const sub = path === '/api/v3' || path === '/api/v3/' ? '' : path.slice('/api/v3/'.length);
      handleRest({
        store,
        req,
        res,
        path: sub.replace(/\/+$/, ''),
        query,
        body,
        host: req.headers.host ?? 'forge.local',
      });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/{service path}.
    const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch !== null) {
      const owner = gitMatch[1] as string;
      const repoName = (gitMatch[2] as string).replace(/\.git$/, '');
      const repo = store.repo(owner, repoName);
      if (repo === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      handleGit({ store, repo, req, res, body, query }, gitMatch[3] as string);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  }

  return { server, store };
}
