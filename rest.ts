// The REST v3 surface under /api/v3: repositories, the contents API (backed by real git
// objects), branches, commits, git refs, labels, issues, comments and pull requests with
// a three-way-merge squash. Every reply is JSON with a request id; errors carry a string
// message. Issue reads answer from a cached buffer, invalidated on any change.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildCommit,
  flattenTree,
  hashObject,
  identityLine,
  isAncestor,
  isOid,
  mergeBase,
  mergeFlatTrees,
  parseCommit,
  parseIdentity,
  parseTree,
  peelToCommit,
  treeEntryAt,
  treeWithPath,
  treeWithoutPath,
  type GitObject,
} from './gitobj.ts';
import { commitTreeChange, lookupOf, putObject } from './githttp.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  type Issue,
  type IssueComment,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  /** The decoded path after /api/v3, without leading or trailing slashes. */
  path: string;
  query: URLSearchParams;
  body: Buffer;
  host: string;
}

type Json = Record<string, unknown>;

function sendJson(ctx: RestContext, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  ctx.res.end(body);
}

function sendBuffer(ctx: RestContext, status: number, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  ctx.res.end(body);
}

function sendEmpty(ctx: RestContext, status: number): void {
  ctx.res.writeHead(status, {});
  ctx.res.end();
}

function fail(ctx: RestContext, status: number, message: string, errors?: unknown[]): void {
  const body: Json = { message };
  if (errors !== undefined) body.errors = errors;
  sendJson(ctx, status, body);
}

/** Parse the request body as a JSON object; a malformed body is a 400, an absent one {}. */
function parseBody(ctx: RestContext): Json | null {
  if (ctx.body.length === 0) return {};
  try {
    const value = JSON.parse(ctx.body.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      fail(ctx, 400, 'Problems parsing JSON: expected an object');
      return null;
    }
    return value as Json;
  } catch {
    fail(ctx, 400, 'Problems parsing JSON');
    return null;
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ---------------------------------------------------------------- serializers

function userJson(): Json {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', VIEWER_ID),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };
}

function repoJson(repo: Repo): Json {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    html_url: `https://forge.local/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.size + repo.pulls.size,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_rebase_merge: true,
    visibility: repo.private ? 'private' : 'public',
  };
}

function labelJson(repo: Repo, label: Label): Json {
  return {
    id: label.id,
    node_id: globalId('Label', label.id),
    url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(repo, label) : { id: 0, name, color: 'ededed', default: false };
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}`,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Json {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://forge.local/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function refSha(repo: Repo, branch: string): string {
  return repo.refs.get(`refs/heads/${branch}`) ?? ZERO_OID;
}

function pullJson(repo: Repo, pull: Pull): Json {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: null,
    mergeable_state: pull.merged ? 'clean' : 'unknown',
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: refSha(repo, pull.headRef),
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: refSha(repo, pull.baseRef),
      user: userJson(),
      repo: repoJson(repo),
    },
    html_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://forge.local/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    draft: false,
  };
}

function commitJson(repo: Repo, oid: string): Json {
  const object = repo.objects.get(oid);
  const view = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const author = view !== null ? parseIdentity(view.author) : { name: '', email: '', timestamp: 0 };
  const committer = view !== null ? parseIdentity(view.committer) : author;
  const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      message: (view?.message ?? '').replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: iso(author.timestamp) },
      committer: { name: committer.name, email: committer.email, date: iso(committer.timestamp) },
      tree: { sha: view?.tree ?? ZERO_OID },
      comment_count: 0,
    },
    parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
    author: userJson(),
    committer: userJson(),
  };
}

// ---------------------------------------------------------------- git-backed helpers

/** Resolve a ref name (branch, tag, or raw oid) to the commit it names, or null. */
function resolveCommit(repo: Repo, ref: string): string | null {
  const lookup = lookupOf(repo);
  const candidates = [`refs/heads/${ref}`, `refs/tags/${ref}`, ref];
  for (const candidate of candidates) {
    const oid = repo.refs.get(candidate) ?? (isOid(candidate) && repo.objects.has(candidate) ? candidate : undefined);
    if (oid === undefined) continue;
    const peeled = peelToCommit(oid, lookup);
    const object = repo.objects.get(peeled);
    if (object !== undefined && object.type === 'commit') return peeled;
  }
  return null;
}

function rootTreeOf(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

function timestampNow(store: Store): number {
  return Math.floor(Date.parse(store.nowIso()) / 1000);
}

function authorLine(store: Store): string {
  return identityLine(VIEWER_NAME, VIEWER_EMAIL, timestampNow(store));
}

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

/** The changed files between a pull request's merge base and its head tip. */
export function pullFiles(repo: Repo, pull: Pull): Json[] {
  const lookup = lookupOf(repo);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(headTip, baseTip, lookup) ?? baseTip;
  const baseTree = rootTreeOf(repo, base);
  const headTree = rootTreeOf(repo, headTip);
  if (baseTree === null || headTree === null) return [];
  const before = flattenTree(baseTree, lookup);
  const after = flattenTree(headTree, lookup);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files: Json[] = [];
  for (const path of paths) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldData = oldEntry !== undefined ? repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
    const newData = newEntry !== undefined ? repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0) : Buffer.alloc(0);
    let status: string;
    let additions: number;
    let deletions: number;
    if (oldEntry === undefined) {
      status = 'added';
      additions = lineCount(newData);
      deletions = 0;
    } else if (newEntry === undefined) {
      status = 'removed';
      additions = 0;
      deletions = lineCount(oldData);
    } else {
      status = 'modified';
      additions = lineCount(newData);
      deletions = lineCount(oldData);
    }
    files.push({
      sha: newEntry?.oid ?? oldEntry?.oid ?? ZERO_OID,
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `https://forge.local/${repo.owner}/${repo.name}/blob/${pull.headRef}/${path}`,
      raw_url: `https://forge.local/${repo.owner}/${repo.name}/raw/${pull.headRef}/${path}`,
      contents_url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${pull.headRef}`,
    });
  }
  return files;
}

/** Whether a pull request can merge cleanly right now (the GraphQL mergeable enum's source). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
  const lookup = lookupOf(repo);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const base = mergeBase(headTip, baseTip, lookup);
  if (base === null) return 'CONFLICTING';
  const baseTree = rootTreeOf(repo, base);
  const oursTree = rootTreeOf(repo, baseTip);
  const theirsTree = rootTreeOf(repo, headTip);
  if (baseTree === null || oursTree === null || theirsTree === null) return 'UNKNOWN';
  const put = (type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string => hashObject(type, data);
  const merged = mergeFlatTrees(flattenTree(baseTree, lookup), flattenTree(oursTree, lookup), flattenTree(theirsTree, lookup), put);
  return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

/** Merge a pull request into its base branch. Returns the merge commit oid, or an error status. */
export function mergePullRecord(repo: Repo, store: Store, pull: Pull, method: string, commitTitle: string | undefined): { sha: string } | { status: number; message: string } {
  if (pull.merged) return { status: 405, message: 'Pull Request is already merged' };
  if (pull.state === 'closed') return { status: 405, message: 'Pull Request is closed' };
  const lookup = lookupOf(repo);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { status: 405, message: 'Pull Request is not mergeable: a branch is missing' };
  const base = mergeBase(headTip, baseTip, lookup);
  if (base === null) return { status: 405, message: 'Pull Request is not mergeable: no common ancestor' };
  const baseTree = rootTreeOf(repo, base);
  const oursTree = rootTreeOf(repo, baseTip);
  const theirsTree = rootTreeOf(repo, headTip);
  if (baseTree === null || oursTree === null || theirsTree === null) return { status: 405, message: 'Pull Request is not mergeable' };
  const put = (type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string => putObject(repo, type, data);
  const merged = mergeFlatTrees(flattenTree(baseTree, lookup), flattenTree(oursTree, lookup), flattenTree(theirsTree, lookup), put);
  if (merged.conflict) return { status: 405, message: 'Merge conflict: the pull request cannot be merged cleanly' };

  const timestamp = timestampNow(store);
  const author = identityLine(VIEWER_NAME, VIEWER_EMAIL, timestamp);
  const message = commitTitle ?? `${pull.title} (#${pull.number})`;
  let sha: string;
  if (method === 'rebase' && isAncestor(baseTip, headTip, lookup)) {
    sha = headTip;
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    store.touchGit(repo);
  } else {
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const commit = buildCommit({ tree: merged.tree, parents, message, author, committer: author, timestamp });
    sha = putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    store.touchGit(repo);
  }
  const now = store.nowIso();
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  pull.mergeCommitSha = sha;
  return { sha };
}

// ---------------------------------------------------------------- shared record creation
// REST, GraphQL and MCP create the same records through these helpers, so an object made
// over one surface reads back identically over the others.

export function createIssueRecord(store: Store, repo: Repo, input: { title: string; body?: string; labels?: string[] }): Issue | { error: string } {
  if (input.title === '') return { error: 'title is required' };
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `label ${JSON.stringify(label)} does not exist` };
  }
  const now = store.nowIso();
  const issue: Issue = {
    id: store.nextId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    cached: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPullRecord(store: Store, repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull | { error: string } {
  const head = input.head.split(':').pop() as string;
  const base = input.base.split(':').pop() as string;
  if (input.title === '' || head === '' || base === '') return { error: 'title, head and base are required' };
  if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) return { error: 'head and base must be existing branches' };
  if (head === base) return { error: 'head and base must differ' };
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) return { error: 'a pull request already exists for this head and base' };
  }
  const now = store.nowIso();
  const pull: Pull = {
    id: store.nextId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function addCommentRecord(store: Store, repo: Repo, issue: Issue, body: string): IssueComment {
  const now = store.nowIso();
  const comment: IssueComment = { id: store.nextId(), body, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  issue.updatedAt = now;
  issue.cached = null;
  return comment;
}

/** Find a repository by its numeric database id (global-id mutation inputs name it). */
export function repoById(store: Store, id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

/** Find an issue by its global numeric id across every repository. */
export function issueById(store: Store, id: number): { repo: Repo; issue: Issue } | undefined {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) if (issue.id === id) return { repo, issue };
  }
  return undefined;
}

/** Find a pull request by its global numeric id across every repository. */
export function pullById(store: Store, id: number): { repo: Repo; pull: Pull } | undefined {
  for (const repo of store.repos.values()) {
    for (const pull of repo.pulls.values()) if (pull.id === id) return { repo, pull };
  }
  return undefined;
}

// ---------------------------------------------------------------- the router

export function handleRest(ctx: RestContext): void {
  const method = (ctx.req.method ?? 'GET').toUpperCase();
  const segments = ctx.path === '' ? [] : ctx.path.split('/');
  const store = ctx.store;

  // Root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, { current_user_url: 'https://forge.local/api/v3/user' }, { 'x-oauth-scopes': 'repo, user' });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(ctx, 200, { verifiable_password_authentication: false, installed_version: '1.0.0' });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(ctx, 200, userJson());
    return;
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      listUserRepos(ctx);
      return;
    }
    if (method === 'POST') {
      createUserRepo(ctx);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.repo(owner, name);
    if (repo === undefined) {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(3);
    handleRepoRoute(ctx, repo, rest, method);
    return;
  }
  fail(ctx, 404, 'Not Found');
}

function listUserRepos(ctx: RestContext): void {
  const all = ctx.store.reposOf(VIEWER_LOGIN);
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage).map((repo) => repoJson(repo));
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const links: string[] = [];
  const url = (target: number): string => `http://${ctx.host}/api/v3/user/repos?per_page=${perPage}&page=${target}`;
  if (page < lastPage) links.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`);
  links.push(`<${url(1)}>; rel="first"`);
  links.push(`<${url(lastPage)}>; rel="last"`);
  sendJson(ctx, 200, items, { link: links.join(', ') });
}

function createUserRepo(ctx: RestContext): void {
  const body = parseBody(ctx);
  if (body === null) return;
  const name = str(body.name);
  if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name.length > 100) {
    fail(ctx, 422, 'Validation Failed', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }]);
    return;
  }
  if (ctx.store.repo(VIEWER_LOGIN, name) !== undefined) {
    fail(ctx, 422, 'Repository creation failed.', [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }]);
    return;
  }
  const repo = ctx.store.createRepo(name, { description: str(body.description), private: body.private === true });
  if (body.auto_init === true) {
    const blobOid = putObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const treeOid = putObject(repo, 'tree', buildTreeInit(blobOid));
    const timestamp = timestampNow(ctx.store);
    const author = identityLine(VIEWER_NAME, VIEWER_EMAIL, timestamp);
    const commit = buildCommit({ tree: treeOid, parents: [], message: 'Initial commit', author, committer: author, timestamp });
    const oid = putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, oid);
    ctx.store.touchGit(repo);
  }
  sendJson(ctx, 201, repoJson(repo));
}

function buildTreeInit(blobOid: string): Buffer {
  // A one-entry tree: README.md at the root.
  const header = Buffer.from('100644 README.md\u0000', 'utf8');
  return Buffer.concat([header, Buffer.from(blobOid, 'hex')]);
}

function handleRepoRoute(ctx: RestContext, repo: Repo, rest: string[], method: string): void {
  const store = ctx.store;

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = parseBody(ctx);
      if (body === null) return;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = store.nowIso();
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      sendEmpty(ctx, 204);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  const section = rest[0] as string;

  if (section === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const items = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice(11), commit: { sha: repo.refs.get(ref) as string }, protected: false }));
      sendJson(ctx, 200, items);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const oid = repo.refs.get(`refs/heads/${rest[1]}`);
      if (oid === undefined) {
        fail(ctx, 404, 'Branch not found');
        return;
      }
      sendJson(ctx, 200, { name: rest[1], commit: { sha: oid }, protected: false });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (section === 'commits' && method === 'GET') {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = resolveCommit(repo, ref);
    if (tip === null) {
      sendJson(ctx, 200, []);
      return;
    }
    const seen = new Set<string>();
    const queue = [tip];
    const commits: Array<{ oid: string; timestamp: number }> = [];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const view = parseCommit(object.data);
      commits.push({ oid, timestamp: parseIdentity(view.committer).timestamp });
      for (const parent of view.parents) queue.push(parent);
    }
    commits.sort((a, b) => b.timestamp - a.timestamp || (a.oid < b.oid ? -1 : 1));
    const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
    const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
    const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
    const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
    const items = commits.slice((page - 1) * perPage, page * perPage).map((entry) => commitJson(repo, entry.oid));
    sendJson(ctx, 200, items);
    return;
  }

  if (section === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return;
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
        fail(ctx, 422, 'Validation Failed', [{ resource: 'Reference', code: 'custom', field: 'ref', message: 'ref or sha is invalid' }]);
        return;
      }
      if (repo.refs.has(ref)) {
        fail(ctx, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      store.touchGit(repo);
      const object = repo.objects.get(sha) as GitObject;
      sendJson(ctx, 201, { ref, node_id: globalId('Ref', ref), object: { sha, type: object.type, url: `https://forge.local/api/v3/repos/${repo.owner}/${repo.name}/git/${object.type}s/${sha}` } });
      return;
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) {
        fail(ctx, 404, 'Not Found');
        return;
      }
      const object = repo.objects.get(oid) as GitObject;
      sendJson(ctx, 200, { ref, node_id: globalId('Ref', ref), object: { sha: oid, type: object.type } });
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (section === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') {
      getContents(ctx, repo, filePath);
      return;
    }
    if (method === 'PUT') {
      putContents(ctx, repo, filePath);
      return;
    }
    if (method === 'DELETE') {
      deleteContents(ctx, repo, filePath);
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (section === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      sendJson(ctx, 200, [...repo.labels.values()].map((label) => labelJson(repo, label)));
      return;
    }
    if (rest.length === 1 && method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return;
      const name = str(body.name);
      if (name === '') {
        fail(ctx, 422, 'Validation Failed', [{ resource: 'Label', code: 'missing_field', field: 'name' }]);
        return;
      }
      if (repo.labels.has(name)) {
        fail(ctx, 422, 'Validation Failed', [{ resource: 'Label', code: 'already_exists', field: 'name' }]);
        return;
      }
      const label: Label = { id: store.nextId(), name, color: str(body.color, 'ededed').replace(/^#/, ''), description: str(body.description) };
      repo.labels.set(name, label);
      sendJson(ctx, 201, labelJson(repo, label));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (section === 'issues') {
    handleIssues(ctx, repo, rest.slice(1), method);
    return;
  }

  if (section === 'pulls') {
    handlePulls(ctx, repo, rest.slice(1), method);
    return;
  }

  fail(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- contents

function getContents(ctx: RestContext, repo: Repo, filePath: string): void {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveCommit(repo, ref);
  if (tip === null) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const tree = rootTreeOf(repo, tip);
  if (tree === null) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const lookup = lookupOf(repo);
  const segments = filePath.split('/').filter((part) => part !== '');
  if (segments.length === 0) {
    const entries = parseTree((repo.objects.get(tree) as GitObject).data).map((entry) => contentEntry(entry.name, entry.name, entry));
    sendJson(ctx, 200, entries);
    return;
  }
  const entry = treeEntryAt(tree, segments, lookup);
  if (entry === null) {
    fail(ctx, 404, 'Not Found');
    return;
  }
  const name = segments[segments.length - 1] as string;
  if (entry.mode === '40000') {
    const child = repo.objects.get(entry.oid);
    if (child === undefined || child.type !== 'tree') {
      fail(ctx, 404, 'Not Found');
      return;
    }
    const entries = parseTree(child.data).map((childEntry) => contentEntry(childEntry.name, `${filePath}/${childEntry.name}`, childEntry));
    sendJson(ctx, 200, entries);
    return;
  }
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') {
    fail(ctx, 404, 'Not Found');
    return;
  }
  sendJson(ctx, 200, {
    name,
    path: filePath,
    sha: entry.oid,
    size: blob.data.length,
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    html_url: `https://forge.local/${repo.owner}/${repo.name}/blob/${ref}/${filePath}`,
  });
}

function contentEntry(name: string, path: string, entry: { mode: string; oid: string }): Json {
  return {
    name,
    path,
    sha: entry.oid,
    size: 0,
    type: entry.mode === '40000' ? 'dir' : 'file',
  };
}

function putContents(ctx: RestContext, repo: Repo, filePath: string): void {
  const body = parseBody(ctx);
  if (body === null) return;
  const segments = filePath.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
  if (segments.length === 0 || typeof body.content !== 'string' || typeof body.message !== 'string') {
    fail(ctx, 422, 'Validation Failed', [{ resource: 'Content', code: 'missing_field', field: 'content' }]);
    return;
  }
  const branch = str(body.branch, repo.defaultBranch);
  const branchRef = `refs/heads/${branch}`;
  if (!repo.refs.has(branchRef)) {
    // A contents write on a fresh branch creates it from the default branch's tip.
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) repo.refs.set(branchRef, defaultTip);
  }
  const tip = repo.refs.get(branchRef);
  const lookup = lookupOf(repo);
  const parentTree = tip !== undefined ? rootTreeOf(repo, tip) : null;
  const parentEntries = parentTree !== null ? parseTree((repo.objects.get(parentTree) as GitObject).data) : [];
  const existing = parentTree !== null ? treeEntryAt(parentTree, segments, lookup) : null;
  const providedSha = typeof body.sha === 'string' ? body.sha : null;
  let status: number;
  if (existing !== null && existing.mode !== '40000') {
    if (providedSha !== existing.oid) {
      fail(ctx, 409, `Conflict: the file's sha does not match the current blob (${existing.oid})`);
      return;
    }
    status = 200;
  } else {
    if (providedSha !== null) {
      fail(ctx, 409, 'Conflict: a sha was provided but the file does not exist');
      return;
    }
    status = 201;
  }
  const bytes = Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = putObject(repo, 'blob', bytes);
  const put = (type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string => putObject(repo, type, data);
  const treeOid = treeWithPath(parentEntries, segments, blobOid, put, lookup);
  const commitOid = commitTreeChange(repo, ctx.store, branch, treeOid, body.message, timestampNow(ctx.store), authorLine(ctx.store));
  sendJson(ctx, status, {
    content: {
      name: segments[segments.length - 1],
      path: segments.join('/'),
      sha: blobOid,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
    },
    commit: commitJson(repo, commitOid),
  });
}

function deleteContents(ctx: RestContext, repo: Repo, filePath: string): void {
  const body = parseBody(ctx);
  if (body === null) return;
  const segments = filePath.split('/').filter((part) => part !== '');
  const branch = str(body.branch, repo.defaultBranch);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined || segments.length === 0 || typeof body.message !== 'string') {
    fail(ctx, 422, 'Validation Failed');
    return;
  }
  const tree = rootTreeOf(repo, tip);
  const lookup = lookupOf(repo);
  const entry = tree !== null ? treeEntryAt(tree, segments, lookup) : null;
  if (tree === null || entry === null || entry.mode === '40000') {
    fail(ctx, 404, 'Not Found');
    return;
  }
  if (typeof body.sha !== 'string' || body.sha !== entry.oid) {
    fail(ctx, 409, 'Conflict: the sha does not match the current blob');
    return;
  }
  const parentEntries = parseTree((repo.objects.get(tree) as GitObject).data);
  const put = (type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string => putObject(repo, type, data);
  const treeOid = treeWithoutPath(parentEntries, segments, put, lookup);
  const commitOid = commitTreeChange(repo, ctx.store, branch, treeOid, body.message, timestampNow(ctx.store), authorLine(ctx.store));
  sendJson(ctx, 200, { content: null, commit: commitJson(repo, commitOid) });
}

// ---------------------------------------------------------------- issues

function handleIssues(ctx: RestContext, repo: Repo, rest: string[], method: string): void {
  const store = ctx.store;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
      const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
      const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
      const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
      const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const slice = items.slice((page - 1) * perPage, page * perPage);
      sendJson(ctx, 200, slice.map((issue) => issueJson(repo, issue)));
      return;
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return;
      const title = str(body.title);
      const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
      const created = createIssueRecord(store, repo, { title, body: str(body.body), labels });
      if ('error' in created) {
        fail(ctx, 422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels', message: created.error }]);
        return;
      }
      sendJson(ctx, 201, issueJson(repo, created));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) {
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      if (issue.cached === null) issue.cached = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
      sendBuffer(ctx, 200, issue.cached);
      return;
    }
    if (method === 'PATCH') {
      const body = parseBody(ctx);
      if (body === null) return;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? store.nowIso() : null;
      }
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((entry): entry is string => typeof entry === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            fail(ctx, 422, 'Validation Failed', [{ resource: 'Issue', code: 'invalid', field: 'labels' }]);
            return;
          }
        }
        issue.labels = labels;
      }
      issue.updatedAt = store.nowIso();
      issue.cached = null;
      sendJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      return;
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return;
      const text = str(body.body);
      if (text === '') {
        fail(ctx, 422, 'Validation Failed', [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }]);
        return;
      }
      const comment = addCommentRecord(store, repo, issue, text);
      sendJson(ctx, 201, commentJson(repo, issue, comment));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  fail(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function handlePulls(ctx: RestContext, repo: Repo, rest: string[], method: string): void {
  const store = ctx.store;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
      const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
      const pageRaw = Number.parseInt(ctx.query.get('page') ?? '1', 10);
      const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
      let items = [...repo.pulls.values()];
      if (state !== 'all') items = items.filter((pull) => pull.state === state);
      items.sort((a, b) => b.number - a.number);
      const slice = items.slice((page - 1) * perPage, page * perPage);
      sendJson(ctx, 200, slice.map((pull) => pullJson(repo, pull)));
      return;
    }
    if (method === 'POST') {
      const body = parseBody(ctx);
      if (body === null) return;
      const created = createPullRecord(store, repo, { title: str(body.title), body: str(body.body), head: str(body.head), base: str(body.base) });
      if ('error' in created) {
        fail(ctx, 422, 'Validation Failed', [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: created.error }]);
        return;
      }
      sendJson(ctx, 201, pullJson(repo, created));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      sendJson(ctx, 200, pullJson(repo, pull));
      return;
    }
    if (method === 'PATCH') {
      const body = parseBody(ctx);
      if (body === null) return;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'open' || body.state === 'closed') {
        pull.state = body.state;
        pull.closedAt = body.state === 'closed' ? store.nowIso() : null;
      }
      pull.updatedAt = store.nowIso();
      sendJson(ctx, 200, pullJson(repo, pull));
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    sendJson(ctx, 200, pullFiles(repo, pull));
    return;
  }

  if (rest[1] === 'merge' && rest.length === 2) {
    if (method === 'PUT') {
      const body = parseBody(ctx);
      if (body === null) return;
      const methodChoice = str(body.merge_method, 'merge');
      if (!['merge', 'squash', 'rebase'].includes(methodChoice)) {
        fail(ctx, 405, 'Merge method is not allowed');
        return;
      }
      const result = mergePullRecord(repo, store, pull, methodChoice, typeof body.commit_title === 'string' ? body.commit_title : undefined);
      if ('status' in result) {
        fail(ctx, result.status, result.message);
        return;
      }
      sendJson(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    if (method === 'GET') {
      if (pull.merged) {
        sendEmpty(ctx, 204);
        return;
      }
      fail(ctx, 404, 'Pull Request is not merged');
      return;
    }
    fail(ctx, 404, 'Not Found');
    return;
  }

  fail(ctx, 404, 'Not Found');
}
