// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over the Streamable HTTP
// transport, speaking the 2026-07-28 revision (server/discover, no handshake, no session)
// and falling back to the initialize handshake for older clients. The six tools act on
// the same store as REST, so an object created here reads back identically there.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Store } from './store.ts';
import { createIssueRecord, createPullRecord, mergePullRecord } from './rest.ts';

const SERVER_INFO = { name: 'makefun-github-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'A GitHub-compatible forge: repositories, issues and pull requests over one store.';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

/** The static tool list: two tools/list calls answer byte-identical JSON. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository under the authenticated user. Returns the repository object with its full_name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name (letters, digits, dot, dash, underscore).' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name. Returns the repository object, or an error when it does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository. Returns the issue object with its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body (markdown).' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state (open, closed, all). Returns an array of issue objects.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all. Defaults to open.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from an existing head branch into an existing base branch. Returns the pull request object with its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body (markdown).' },
        head: { type: 'string', description: 'The head branch name (the changes).' },
        base: { type: 'string', description: 'The base branch name (the target).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch. Returns the pull request object with merged: true.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        merge_method: { type: 'string', description: 'Merge method: merge, squash or rebase. Defaults to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcRequest {
  id: string | number | null;
  method: string;
  params: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function repoSummary(repo: { id: number; owner: string; name: string; description: string; private: boolean; defaultBranch: string }): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueSummary(issue: { id: number; number: number; title: string; body: string; state: string; labels: string[] }): Record<string, unknown> {
  return { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels };
}

function pullSummary(pull: { id: number; number: number; title: string; state: string; merged: boolean; headRef: string; baseRef: string }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    pull_number: pull.number,
    title: pull.title,
    state: pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef },
    base: { ref: pull.baseRef },
  };
}

function argStr(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === 'string' ? value : '';
}

/** Run one validated tool against the store; a tool-level failure is isError, never an HTTP 500. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = argStr(args, 'name');
      if (!/^[A-Za-z0-9._-]+$/.test(repoName) || repoName.length > 100) return toolFailure('Invalid repository name');
      if (store.repo(VIEWER_LOGIN, repoName) !== undefined) return toolFailure(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = store.createRepo(repoName, { description: argStr(args, 'description'), private: args.private === true });
      return toolText(repoSummary(repo));
    }
    case 'get_repo': {
      const repo = store.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === undefined) return toolFailure('Repository not found');
      return toolText(repoSummary(repo));
    }
    case 'create_issue': {
      const repo = store.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === undefined) return toolFailure('Repository not found');
      const created = createIssueRecord(store, repo, { title: argStr(args, 'title'), body: argStr(args, 'body') });
      if ('error' in created) return toolFailure(created.error);
      return toolText(issueSummary(created));
    }
    case 'list_issues': {
      const repo = store.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === undefined) return toolFailure('Repository not found');
      const state = argStr(args, 'state') || 'open';
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => b.number - a.number);
      return toolText(items.map((issue) => issueSummary(issue)));
    }
    case 'create_pull_request': {
      const repo = store.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === undefined) return toolFailure('Repository not found');
      const created = createPullRecord(store, repo, {
        title: argStr(args, 'title'),
        body: argStr(args, 'body'),
        head: argStr(args, 'head'),
        base: argStr(args, 'base'),
      });
      if ('error' in created) return toolFailure(created.error);
      return toolText(pullSummary(created));
    }
    case 'merge_pull_request': {
      const repo = store.repo(argStr(args, 'owner'), argStr(args, 'repo'));
      if (repo === undefined) return toolFailure('Repository not found');
      const rawNumber = args.pull_number;
      const number = typeof rawNumber === 'number' ? rawNumber : Number.parseInt(String(rawNumber), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolFailure('Pull request not found');
      const method = argStr(args, 'merge_method') || 'merge';
      const result = mergePullRecord(repo, store, pull, method, undefined);
      if ('status' in result) return toolFailure(result.message);
      return toolText(pullSummary(pull));
    }
    default:
      return toolFailure(`Unknown tool: ${name}`);
  }
}

/** Dispatch one JSON-RPC request; notifications (no id) answer null. */
function dispatch(store: Store, request: RpcRequest): Record<string, unknown> | null {
  const { id, method, params } = request;
  const isNotification = id === null || id === undefined;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'io.modelcontextprotocol/discoverResult',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      for (const required of tool.inputSchema.required) {
        const value = args[required];
        if (value === undefined || value === null || value === '') {
          return rpcError(id, -32602, `Missing required argument: ${required}`);
        }
      }
      const outcome = callTool(store, name, args);
      return rpcResult(id, outcome);
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export interface McpContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}

export function handleMcp(ctx: McpContext): void {
  const { req, res, body, store } = ctx;
  const method = req.method ?? 'POST';
  if (method === 'DELETE') {
    // No protocol-level session exists in the modern era; a goodbye is accepted anyway.
    res.writeHead(200, { 'content-length': 0 });
    res.end();
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  const toRequest = (entry: unknown): RpcRequest | null => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.method !== 'string') return null;
    const id = record.id;
    return {
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      method: record.method,
      params: typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params) ? (record.params as Record<string, unknown>) : {},
    };
  };
  if (Array.isArray(parsed)) {
    const answers: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      const request = toRequest(entry);
      if (request === null) {
        answers.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const answer = dispatch(store, request);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202, { 'content-length': 0 });
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  const request = toRequest(parsed);
  if (request === null) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const answer = dispatch(store, request);
  if (answer === null) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}
