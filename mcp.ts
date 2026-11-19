// MCP over streamable HTTP at /mcp: JSON-RPC 2.0, revision 2026-07-28 (server/discover),
// with the initialize handshake for older clients. Tools act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, sendJson } from './forge.ts';
import {
  OWNER,
  NOW_ISO,
  type Repo,
  type Issue,
  type Pull,
  repos,
  createRepo,
  newIssueId,
  newPullId,
  branchTip,
} from './store.ts';
import { squashMerge } from './rest.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- tool schemas

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: { type: 'string', description: 'Owner login (the authenticated user)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

// ---------------------------------------------------------------- tool execution

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${OWNER}/${repo.name}`,
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: OWNER, id: 1 },
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    repository: `${OWNER}/${repo.name}`,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: branchTip(repo, pull.head) ?? '' },
    base: { ref: pull.base, sha: branchTip(repo, pull.base) ?? '' },
    created_at: pull.createdAt,
    merged_at: pull.mergedAt,
  };
}

function findRepo(args: Record<string, unknown>): Repo | undefined {
  const owner = String(args.owner ?? OWNER);
  if (owner !== OWNER) return undefined;
  return repos.get(String(args.repo ?? args.name ?? ''));
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) {
    return rpcError(null, -32601, `Unknown tool: ${name}`);
  }
  const required = (tool.inputSchema.required ?? []) as string[];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return rpcError(null, -32602, `Missing required arguments: ${missing.join(', ')}`);
  }

  if (name === 'create_repo') {
    const repoName = String(args.name ?? '');
    if (repos.has(repoName)) return toolFail(`Repository ${repoName} already exists`);
    const repo = createRepo(repoName, args.private === true, String(args.description ?? ''));
    return toolOk(repoJson(repo));
  }

  const repo = findRepo(args);
  if (repo === undefined) return toolFail(`Repository ${String(args.owner ?? OWNER)}/${String(args.repo ?? '')} not found`);

  if (name === 'get_repo') {
    return toolOk(repoJson(repo));
  }
  if (name === 'create_issue') {
    const issue: Issue = {
      id: newIssueId(),
      number: repo.nextIssue++,
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
      state: 'open',
      labels: [],
      comments: [],
      createdAt: NOW_ISO,
      closedAt: null,
    };
    repo.issues.push(issue);
    return toolOk(issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = String(args.state ?? 'open');
    const list = repo.issues.filter((issue) => (state === 'all' ? true : issue.state === state));
    return toolOk(list.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    if (branchTip(repo, head) === undefined) return toolFail(`Head branch ${head} does not exist`);
    if (branchTip(repo, base) === undefined) return toolFail(`Base branch ${base} does not exist`);
    if (head === base) return toolFail('Head and base must differ');
    const pull: Pull = {
      id: newPullId(),
      number: repo.nextPull++,
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
      head,
      base,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: NOW_ISO,
      closedAt: null,
    };
    repo.pulls.push(pull);
    return toolOk(pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolFail(`Pull request #${number} not found`);
    const outcome = squashMerge(repo, pull);
    if (!outcome.ok) return toolFail(outcome.reason);
    return toolOk({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', pull_number: number });
  }
  return rpcError(null, -32601, `Unknown tool: ${name}`);
}

// ---------------------------------------------------------------- the endpoint

export async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: body is not JSON'));
    return;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const rpc = body as RpcRequest;
  const id = rpc.id ?? null;
  const method = String(rpc.method ?? '');
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (method === 'initialize') {
    const offered = String(params.protocolVersion ?? PROTOCOL_VERSION);
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : PROTOCOL_VERSION;
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    }));
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: JSON.parse(TOOLS_JSON) }));
    return;
  }
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(name, args);
    if ('error' in outcome) {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: (outcome as { error: unknown }).error });
      return;
    }
    sendJson(res, 200, rpcResult(id, outcome));
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}