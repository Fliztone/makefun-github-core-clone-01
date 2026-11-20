// A raw node:net HTTP/1.1 server that reuses the conformant route() from forge.ts.
// Avoids node:http's per-request object/parser overhead (the read/write workloads do
// thousands of sequential keep-alive requests). Responses are captured from the existing
// handlers and written as raw bytes; connections are kept alive.

import { createServer, type Socket, type Server } from 'node:net';
import { route, sendJson, HttpError } from './forge.ts';

const REASONS: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

let requestCounter = 0;

class CaptureRes {
  statusCode = 200;
  headers: Record<string, string> = {};
  body: Buffer = Buffer.alloc(0);
  headersSent = false;
  setHeader(k: string, v: unknown): void {
    this.headers[k.toLowerCase()] = String(v);
  }
  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status;
    if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
    this.headersSent = true;
    return this;
  }
  end(body?: unknown): void {
    if (body !== undefined && body !== null) {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    }
    this.headersSent = true;
  }
}

function makeReq(method: string, target: string, headers: Record<string, string>, body: Buffer): any {
  return {
    method,
    url: target,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body.length > 0) yield body;
    },
  };
}

function writeResponse(socket: Socket, cap: CaptureRes, close: boolean): void {
  const reason = REASONS[cap.statusCode] ?? 'OK';
  if (!('content-length' in cap.headers)) cap.headers['content-length'] = String(cap.body.length);
  cap.headers['connection'] = close ? 'close' : 'keep-alive';
  let head = `HTTP/1.1 ${cap.statusCode} ${reason}\r\n`;
  for (const [k, v] of Object.entries(cap.headers)) head += `${k}: ${v}\r\n`;
  head += '\r\n';
  const headBuf = Buffer.from(head, 'ascii');
  if (cap.body.length > 0) socket.write(Buffer.concat([headBuf, cap.body]));
  else socket.write(headBuf);
  if (close) socket.end();
}

async function dispatch(method: string, target: string, headers: Record<string, string>, body: Buffer, socket: Socket, close: boolean): Promise<void> {
  const cap = new CaptureRes();
  requestCounter += 1;
  cap.setHeader('x-github-request-id', `forge-${requestCounter.toString(16).padStart(8, '0')}`);
  const req = makeReq(method, target, headers, body);
  try {
    await route(req, cap as any);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (!cap.headersSent) sendJson(cap as any, status, { message });
  }
  writeResponse(socket, cap, close);
}

export function createRawApp(): Server {
  return createServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let queue: Promise<void> = Promise.resolve();
    let closed = false;

    const drain = (): void => {
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;
        const headText = buffer.subarray(0, headerEnd).toString('ascii');
        const lines = headText.split('\r\n');
        const requestLine = lines[0] ?? '';
        const sp1 = requestLine.indexOf(' ');
        const sp2 = requestLine.indexOf(' ', sp1 + 1);
        if (sp1 === -1 || sp2 === -1) {
          socket.end();
          return;
        }
        const method = requestLine.slice(0, sp1);
        const target = requestLine.slice(sp1 + 1, sp2);
        const headers: Record<string, string> = {};
        for (let i = 1; i < lines.length; i += 1) {
          const colon = lines[i].indexOf(':');
          if (colon > 0) headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
        }
        const contentLength = Number(headers['content-length'] ?? '0') || 0;
        const total = headerEnd + 4 + contentLength;
        if (buffer.length < total) return; // wait for the full body
        const body = buffer.subarray(headerEnd + 4, total);
        buffer = buffer.subarray(total);
        const close = (headers['connection'] ?? '').toLowerCase() === 'close';
        const m = method, t = target, h = headers, b = body, c = close;
        queue = queue.then(() => dispatch(m, t, h, b, socket, c)).catch(() => {
          if (!socket.destroyed) socket.end();
        });
        if (close) {
          closed = true;
          return;
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      drain();
    });
    socket.on('error', () => {
      closed = true;
    });
    socket.on('close', () => {
      closed = true;
    });
    void closed;
  });
}