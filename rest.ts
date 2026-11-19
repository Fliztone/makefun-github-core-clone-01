// REST v3 under /api/v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, with GitHub's status codes and JSON shapes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendEmpty, sendJson } from './forge.ts';
import {
  OWNER,
  NOW_ISO,
  GIT_DATE,
  type Repo,
  type Issue,
  type Pull,
  type FileEntry,
  repos,
  createRepo,
  newIssueId,
  newCommentId,
  newPullId,
  newLabelId,
  branchTip,
  gid,
  getObject,
  putObject,
  buildTree,
  makeCommit,
  commitFiles,
  parseCommit,
  mergeBase,
  diffFiles,
  isAncestor,
} from './store.ts';

type Json = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function userJson(): Json {
  return {
    login: OWNER,
    id: 1,
    node_id: gid('User', 1),
    avatar_url: '',
    gravatar_id: '',
    type: 'User',
    site_admin: false,
  };
}

function repoJson(repo: Repo): Json {
  const openIssues = repo.issues.filter((i) => i.state === 'open').length;
  const openPulls = repo.pulls.filter((p) => p.state === 'open').length;
  return {
    id: repo.databaseId,
    node_id: gid('Repository', repo.databaseId),
    name: repo.name,
    full_name: `${OWNER}/${repo.name}`,
    private: repo.private,
    owner: userJson(),
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    homepage: null,
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
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Json | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return { id: label.id, node_id: gid('Label', label.id), name: label.name, color: label.color, default: false };
}

function issueJson(repo: Repo, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: gid('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)).filter((l) => l !== null),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    repository_url: `/api/v3/repos/${OWNER}/${repo.name}`,
    html_url: `https://github.com/${OWNER}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(comment: { id: number; body: string; createdAt: string }): Json {
  return {
    id: comment.id,
    node_id: gid('IssueComment', comment.id),
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: Pull): Json {
  const headSha = branchTip(repo, pull.head) ?? '';
  const baseSha = branchTip(repo, pull.base) ?? '';
  const side = (ref: string, sha: string): Json => ({
    label: `${OWNER}:${ref}`,
    ref,
    sha,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: gid('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    head: side(pull.head, headSha),
    base: side(pull.base, baseSha),
    merged: pull.merged,
    mergeable: pull.state === 'open' ? true : null,
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    closed_at: pull.closedAt,
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
    draft: false,
    author_association: 'OWNER',
    html_url: `https://github.com/${OWNER}/${repo.name}/pull/${pull.number}`,
  };
}

function isoFromGitDate(line: string): string {
  const m = /(\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return NOW_ISO;
  return new Date(Number(m[1]) * 1000).toISOString();
}

function identityJson(line: string): Json {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return { name: OWNER, email: `${OWNER}@users.noreply.github.com`, date: NOW_ISO };
  return { name: m[1], email: m[2], date: isoFromGitDate(line) };
}

function commitJson(sha: string): Json {
  const info = parseCommit(sha);
  const message = info?.message ?? '';
  const author = info ? identityJson(info.author) : { name: OWNER, email: '', date: NOW_ISO };
  const committer = info ? identityJson(info.committer) : author;
  return {
    sha,
    node_id: gid('Commit', sha),
    commit: {
      author,
      committer,
      message,
      tree: { sha: info?.tree ?? '', url: '' },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson(),
    committer: userJson(),
    parents: (info?.parents ?? []).map((p) => ({ sha: p, url: '' })),
    html_url: `https://github.com/${OWNER}/commit/${sha}`,
  };
}

function requireRepo(owner: string, name: string): Repo {
  if (owner !== OWNER) throw new HttpError(404, 'Not Found');
  const repo = repos.get(name);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  return repo;
}

function paginate<T>(items: T[], url: URL, req: IncomingMessage, render: (item: T) => Json): void {
  // handled by caller via pageSlice; placeholder to keep imports tidy
  void items;
  void url;
  void req;
  void render;
}
void paginate;

function pageSlice<T>(items: T[], url: URL): { page: T[]; perPage: number; pageNum: number; totalPages: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum, totalPages };
}

function linkHeader(req: IncomingMessage, url: URL, pageNum: number, totalPages: number, perPage: number): string {
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${url.pathname}`;
  const at = (n: number): string => `<${base}?per_page=${perPage}&page=${n}>`;
  const links: string[] = [];
  if (pageNum < totalPages) links.push(`${at(pageNum + 1)}; rel="next"`, `${at(totalPages)}; rel="last"`);
  if (pageNum > 1) links.push(`${at(pageNum - 1)}; rel="prev"`, `${at(1)}; rel="first"`);
  return links.join(', ');
}

function resolveRef(repo: Repo, name: string): string | undefined {
  const asBranch = repo.refs.get(`refs/heads/${name}`);
  if (asBranch !== undefined) return asBranch;
  const direct = repo.refs.get(name);
  if (direct !== undefined) return direct;
  const obj = getObject(name);
  if (obj !== undefined && obj.type === 'commit') return name;
  return undefined;
}

function historyFrom(tip: string | undefined, limit: number): string[] {
  if (tip === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && out.length < limit) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    const info = parseCommit(cur);
    if (info === undefined) continue;
    seen.add(cur);
    out.push(cur);
    for (const p of info.parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- contents helpers

function contentsPath(segments: string[]): string {
  return segments.join('/');
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function fileContentJson(path: string, entry: FileEntry): Json {
  const obj = getObject(entry.sha);
  const data = obj?.data ?? Buffer.alloc(0);
  return {
    name: baseName(path),
    path,
    sha: entry.sha,
    size: data.length,
    type: 'file',
    encoding: 'base64',
    content: data.toString('base64'),
  };
}

function dirEntries(repo: Repo, tip: string, dir: string): Json[] {
  const files = commitFiles(tip);
  const prefix = dir === '' ? '' : `${dir}/`;
  const names = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = getObject(entry.sha);
      names.set(rest, { type: 'file', sha: entry.sha, size: obj?.data.length ?? 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!names.has(name)) names.set(name, { type: 'dir', sha: '', size: 0 });
    }
  }
  const out: Json[] = [];
  for (const [name, info] of [...names.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const path = prefix === '' ? name : `${prefix}${name}`;
    let sha = info.sha;
    if (info.type === 'dir') {
      const sub = new Map<string, FileEntry>();
      for (const [path2, entry] of files) {
        if (path2.startsWith(`${path}/`)) sub.set(path2.slice(path.length + 1), entry);
      }
      sha = buildTree(sub);
    }
    out.push({ name, path, sha, size: info.size, type: info.type });
  }
  return out;
}

function commitContentChange(
  repo: Repo,
  branch: string,
  mutate: (files: Map<string, FileEntry>) => void,
  message: string,
): { commitSha: string; files: Map<string, FileEntry> } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const files = new Map(tip !== undefined ? commitFiles(tip) : new Map<string, FileEntry>());
  mutate(files);
  const tree = buildTree(files);
  const commitSha = makeCommit(tree, tip !== undefined ? [tip] : [], message);
  repo.refs.set(ref, commitSha);
  return { commitSha, files };
}

// ---------------------------------------------------------------- shared merge

/** Squash-merge a pull request onto its base; the one merge path REST and GraphQL share. */
export function squashMerge(repo: Repo, pull: Pull): { ok: boolean; sha: string | null; reason: string } {
  if (pull.state !== 'open' || pull.merged) return { ok: false, sha: null, reason: 'Pull Request is not mergeable' };
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return { ok: false, sha: null, reason: 'Pull Request is not mergeable' };
  if (isAncestor(headTip, baseTip)) return { ok: false, sha: null, reason: 'No commits between base and head' };
  const mb = mergeBase(headTip, baseTip);
  const mbFiles = mb !== null ? commitFiles(mb) : new Map<string, FileEntry>();
  const baseFiles = commitFiles(baseTip);
  const headFiles = commitFiles(headTip);
  const baseChanges = new Map(diffFiles(mbFiles, baseFiles).map((c) => [c.path, c]));
  const headChanges = diffFiles(mbFiles, headFiles);
  for (const change of headChanges) {
    const other = baseChanges.get(change.path);
    if (other === undefined) continue;
    const baseEntry = baseFiles.get(change.path);
    const headEntry = headFiles.get(change.path);
    if ((baseEntry?.sha ?? null) !== (headEntry?.sha ?? null)) {
      return { ok: false, sha: null, reason: 'Pull Request is not mergeable: merge conflict' };
    }
  }
  const result = new Map(baseFiles);
  for (const change of headChanges) {
    const entry = headFiles.get(change.path);
    if (entry === undefined) result.delete(change.path);
    else result.set(change.path, entry);
  }
  const tree = buildTree(result);
  const mergeSha = makeCommit(tree, [baseTip], `${pull.title} (#${pull.number})`);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = NOW_ISO;
  pull.closedAt = NOW_ISO;
  return { ok: true, sha: mergeSha, reason: '' };
}

/** Whether an open pull request can merge cleanly (GraphQL's mergeable enum). */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open' || pull.merged) return 'UNKNOWN';
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const mb = mergeBase(headTip, baseTip);
  const mbFiles = mb !== null ? commitFiles(mb) : new Map<string, FileEntry>();
  const baseFiles = commitFiles(baseTip);
  const headFiles = commitFiles(headTip);
  const baseChanges = new Map(diffFiles(mbFiles, baseFiles).map((c) => [c.path, c]));
  for (const change of diffFiles(mbFiles, headFiles)) {
    if (!baseChanges.has(change.path)) continue;
    if ((baseFiles.get(change.path)?.sha ?? null) !== (headFiles.get(change.path)?.sha ?? null)) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** The changed files of a pull request, base...head (REST files list and GraphQL files share it). */
export function pullChanges(repo: Repo, pull: Pull): ReturnType<typeof diffFiles> {
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return [];
  const mb = mergeBase(headTip, baseTip);
  const oldFiles = mb !== null ? commitFiles(mb) : new Map<string, FileEntry>();
  return diffFiles(oldFiles, commitFiles(headTip));
}

// ---------------------------------------------------------------- the router

export async function handleRest(req: IncomingMessage, res: ServerResponse, sub: string, url: URL, method: string): Promise<void> {
  const segments = sub.split('/').filter((s) => s !== '');

  // API root and meta
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '3.14.0', verifiable_password_authentication: false });
    return;
  }
  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    sendJson(res, 200, { ...userJson(), name: OWNER, public_repos: repos.size, total_private_repos: repos.size });
    return;
  }
  if (segments[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: {}, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
    return;
  }

  // /user/repos
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...repos.values()];
      const { page, perPage, pageNum, totalPages } = pageSlice(all, url);
      const headers: Record<string, string> = {};
      const link = linkHeader(req, url, pageNum, totalPages, perPage);
      if (link !== '') headers.link = link;
      sendJson(res, 200, page.map(repoJson), headers);
      return;
    }
    if (method === 'POST') {
      const body = await readJson(req);
      const name = str(body.name);
      if (name === '') throw new HttpError(422, 'Repository name is required');
      if (repos.has(name)) throw new HttpError(422, 'Repository creation failed: name already exists on this account');
      const repo = createRepo(name, body.private === true, str(body.description));
      sendJson(res, 201, repoJson(repo));
      return;
    }
    throw new HttpError(404, 'Not Found');
  }

  // /repos/{owner}/{repo}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = requireRepo(segments[1], segments[2]);
    const rest = segments.slice(3);
    const repoPath = `/api/v3/repos/${OWNER}/${repo.name}`;

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        repos.delete(repo.name);
        sendEmpty(res, 204);
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    // branches
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const out: Json[] = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        out.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false });
      }
      out.sort((a, b) => (str(a.name) < str(b.name) ? -1 : 1));
      sendJson(res, 200, out);
      return;
    }
    if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, { name: rest[1], commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false });
      return;
    }

    // git/refs reads
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) throw new HttpError(404, 'Not Found');
      const obj = getObject(sha);
      sendJson(res, 200, { ref, node_id: gid('Ref', ref), object: { sha, type: obj?.type ?? 'commit', url: `${repoPath}/git/${obj?.type ?? 'commit'}s/${sha}` } });
      return;
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
      const body = await readJson(req);
      const ref = str(body.ref);
      const sha = str(body.sha).toLowerCase();
      if (!ref.startsWith('refs/')) throw new HttpError(422, 'Reference must start with refs/');
      if (repo.refs.has(ref)) throw new HttpError(422, 'Reference already exists');
      const obj = getObject(sha);
      if (obj === undefined) throw new HttpError(422, 'Object does not exist');
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: gid('Ref', ref), object: { sha, type: obj.type, url: `${repoPath}/git/${obj.type}s/${sha}` } });
      return;
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const refName = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, refName);
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
      const shas = historyFrom(tip, perPage);
      sendJson(res, 200, shas.map(commitJson));
      return;
    }
    if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
      const sha = resolveRef(repo, rest[1]);
      if (sha === undefined || parseCommit(sha) === undefined) throw new HttpError(404, 'Not Found');
      sendJson(res, 200, commitJson(sha));
      return;
    }

    // contents
    if (rest[0] === 'contents' && rest.length >= 2) {
      const path = contentsPath(rest.slice(1));
      const branch = url.searchParams.get('ref') ?? repo.defaultBranch;
      const ref = `refs/heads/${branch}`;
      const tip = repo.refs.get(ref) ?? resolveRef(repo, branch);

      if (method === 'GET') {
        if (tip === undefined) throw new HttpError(404, 'Not Found');
        const files = commitFiles(tip);
        if (path === '') {
          sendJson(res, 200, dirEntries(repo, tip, ''));
          return;
        }
        const entry = files.get(path);
        if (entry !== undefined) {
          sendJson(res, 200, fileContentJson(path, entry));
          return;
        }
        const entries = dirEntries(repo, tip, path);
        if (entries.length > 0) {
          sendJson(res, 200, entries);
          return;
        }
        throw new HttpError(404, 'Not Found');
      }

      if (method === 'PUT') {
        const body = await readJson(req);
        const targetBranch = str(body.branch) || repo.defaultBranch;
        const targetRef = `refs/heads/${targetBranch}`;
        const targetTip = repo.refs.get(targetRef);
        const current = targetTip !== undefined ? commitFiles(targetTip) : new Map<string, FileEntry>();
        const existing = current.get(path);
        const message = str(body.message);
        if (message === '') throw new HttpError(422, 'Commit message is required');
        if (typeof body.sha === 'string') {
          if (existing === undefined || existing.sha !== body.sha.toLowerCase()) {
            throw new HttpError(409, 'File does not match the provided sha');
          }
        }
        const content = Buffer.from(str(body.content), 'base64');
        const blobSha = putObject('blob', content);
        const { commitSha } = commitContentChange(repo, targetBranch, (files) => {
          files.set(path, { sha: blobSha, mode: '100644' });
        }, message);
        sendJson(res, existing === undefined ? 201 : 200, {
          content: { name: baseName(path), path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', content: content.toString('base64') },
          commit: commitJson(commitSha),
        });
        return;
      }

      if (method === 'DELETE') {
        const body = await readJson(req);
        const targetBranch = str(body.branch) || repo.defaultBranch;
        const targetTip = repo.refs.get(`refs/heads/${targetBranch}`);
        const current = targetTip !== undefined ? commitFiles(targetTip) : new Map<string, FileEntry>();
        const existing = current.get(path);
        if (existing === undefined) throw new HttpError(404, 'Not Found');
        if (typeof body.sha === 'string' && existing.sha !== body.sha.toLowerCase()) {
          throw new HttpError(409, 'File does not match the provided sha');
        }
        const message = str(body.message) || `Delete ${path}`;
        const { commitSha } = commitContentChange(repo, targetBranch, (files) => {
          files.delete(path);
        }, message);
        sendJson(res, 200, { content: null, commit: commitJson(commitSha) });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    // labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') {
        const body = await readJson(req);
        const name = str(body.name);
        if (name === '') throw new HttpError(422, 'Label name is required');
        if (repo.labels.has(name)) throw new HttpError(422, 'Label already exists');
        const label = { id: newLabelId(), name, color: str(body.color) || 'ededed' };
        repo.labels.set(name, label);
        sendJson(res, 201, { id: label.id, node_id: gid('Label', label.id), name: label.name, color: label.color, default: false });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, node_id: gid('Label', l.id), name: l.name, color: l.color, default: false })));
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readJson(req);
          const title = str(body.title);
          if (title === '') throw new HttpError(422, 'Issue title is required');
          const labels = Array.isArray(body.labels) ? body.labels.map(str) : [];
          for (const name of labels) {
            if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist`);
          }
          const issue: Issue = {
            id: newIssueId(),
            number: repo.nextIssue++,
            title,
            body: str(body.body),
            state: 'open',
            labels,
            comments: [],
            createdAt: NOW_ISO,
            closedAt: null,
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
          list = [...list].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, perPage, pageNum, totalPages } = pageSlice(list, url);
          const headers: Record<string, string> = {};
          const link = linkHeader(req, url, pageNum, totalPages, perPage);
          if (link !== '') headers.link = link;
          sendJson(res, 200, page.map((i) => issueJson(repo, i)), headers);
          return;
        }
        throw new HttpError(404, 'Not Found');
      }

      const number = Number(rest[1]);
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) throw new HttpError(404, 'Not Found');

      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const body = await readJson(req);
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') {
            issue.state = body.state;
            issue.closedAt = body.state === 'closed' ? NOW_ISO : null;
          }
          if (Array.isArray(body.labels)) {
            const labels = body.labels.map(str);
            for (const name of labels) {
              if (!repo.labels.has(name)) throw new HttpError(422, `Label "${name}" does not exist`);
            }
            issue.labels = labels;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return;
        }
        throw new HttpError(404, 'Not Found');
      }

      if (rest[2] === 'comments') {
        if (rest.length === 3 && method === 'POST') {
          const body = await readJson(req);
          const comment = { id: newCommentId(), body: str(body.body), createdAt: NOW_ISO };
          issue.comments.push(comment);
          sendJson(res, 201, commentJson(comment));
          return;
        }
        if (rest.length === 3 && method === 'GET') {
          sendJson(res, 200, issue.comments.map(commentJson));
          return;
        }
      }
      throw new HttpError(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = await readJson(req);
          const title = str(body.title);
          const head = str(body.head);
          const base = str(body.base);
          if (title === '' || head === '' || base === '') throw new HttpError(422, 'Title, head and base are required');
          if (branchTip(repo, head) === undefined) throw new HttpError(422, `Head branch "${head}" does not exist`);
          if (branchTip(repo, base) === undefined) throw new HttpError(422, `Base branch "${base}" does not exist`);
          if (head === base) throw new HttpError(422, 'Head and base must differ');
          const pull: Pull = {
            id: newPullId(),
            number: repo.nextPull++,
            title,
            body: str(body.body),
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
          sendJson(res, 201, pullJson(repo, pull));
          return;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
          const { page, perPage, pageNum, totalPages } = pageSlice(list, url);
          const headers: Record<string, string> = {};
          const link = linkHeader(req, url, pageNum, totalPages, perPage);
          if (link !== '') headers.link = link;
          sendJson(res, 200, page.map((p) => pullJson(repo, p)), headers);
          return;
        }
        throw new HttpError(404, 'Not Found');
      }

      const number = Number(rest[1]);
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) throw new HttpError(404, 'Not Found');

      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        const body = await readJson(req);
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        if (body.state === 'closed' && !pull.merged) {
          pull.state = 'closed';
          pull.closedAt = NOW_ISO;
        }
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }

      if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
        const headTip = branchTip(repo, pull.head);
        const baseTip = branchTip(repo, pull.base);
        if (headTip === undefined || baseTip === undefined) throw new HttpError(404, 'Not Found');
        const mb = mergeBase(headTip, baseTip);
        const oldFiles = mb !== null ? commitFiles(mb) : new Map<string, FileEntry>();
        const newFiles = commitFiles(headTip);
        const changes = diffFiles(oldFiles, newFiles);
        sendJson(res, 200, changes.map((c) => ({
          sha: newFiles.get(c.path)?.sha ?? '',
          filename: c.path,
          status: c.status,
          additions: c.additions,
          deletions: c.deletions,
          changes: c.additions + c.deletions,
        })));
        return;
      }

      if (rest[2] === 'merge' && rest.length === 3 && method === 'PUT') {
        await readJson(req);
        const outcome = squashMerge(repo, pull);
        if (!outcome.ok) throw new HttpError(405, outcome.reason);
        sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      throw new HttpError(404, 'Not Found');
    }

    throw new HttpError(404, 'Not Found');
  }

  throw new HttpError(404, 'Not Found');
}