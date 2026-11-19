// In-memory state for the forge: repositories, git objects, issues, labels, pulls.
// Everything is deterministic: timestamps come from MAKEFUN_TRIAL_NOW, ids are sequential,
// and git objects are content-addressed, so two runs of the same trial leave the same state.

import { createHash } from 'node:crypto';

/** The login the trial's token names; constant across this contest's trials. */
export const OWNER = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';
/** The only "now" a trial carries; every timestamp we emit derives from it. */
export const NOW_ISO = process.env.MAKEFUN_TRIAL_NOW ?? '2026-01-01T00:00:00Z';
const NOW_EPOCH = Math.floor(Date.parse(NOW_ISO) / 1000);
export const GIT_DATE = `${NOW_EPOCH} +0000`;
export const IDENTITY = `${OWNER} <${OWNER}@users.noreply.github.com>`;

// ---------------------------------------------------------------- git objects

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

/** Every object the forge holds, by sha1; pushed objects are stored byte for byte. */
export const objects = new Map<string, GitObject>();

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function putObject(type: ObjType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

export function getObject(sha: string): GitObject | undefined {
  return objects.get(sha.toLowerCase());
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

const commitCache = new Map<string, CommitInfo>();

/** Parse a commit object's headers and message (one trailing newline stripped). */
export function parseCommit(sha: string): CommitInfo | undefined {
  const cached = commitCache.get(sha);
  if (cached !== undefined) return cached;
  const obj = getObject(sha);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  const text = obj.data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  let message = split === -1 ? '' : text.slice(split + 2);
  if (message.endsWith('\n')) message = message.slice(0, -1);
  const info: CommitInfo = { tree: '', parents: [], message, author: '', committer: '' };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  commitCache.set(sha, info);
  return info;
}

export interface FileEntry {
  sha: string;
  mode: string;
}

const flatCache = new Map<string, Map<string, FileEntry>>();

/** Walk a tree object into a flat path -> blob map (cached per tree sha). */
export function flatFiles(treeSha: string, prefix = ''): Map<string, FileEntry> {
  const key = `${treeSha}:${prefix}`;
  const cached = flatCache.get(key);
  if (cached !== undefined) return cached;
  const out = new Map<string, FileEntry>();
  const obj = getObject(treeSha);
  if (obj !== undefined && obj.type === 'tree') {
    const data = obj.data;
    let at = 0;
    while (at < data.length) {
      const space = data.indexOf(0x20, at);
      const nul = data.indexOf(0x00, space + 1);
      const mode = data.subarray(at, space).toString('ascii');
      const name = data.subarray(space + 1, nul).toString('utf8');
      const sha = data.subarray(nul + 1, nul + 21).toString('hex');
      at = nul + 21;
      const path = prefix === '' ? name : `${prefix}/${name}`;
      if (mode === '40000' || mode === '040000') {
        for (const [p, e] of flatFiles(sha, path)) out.set(p, e);
      } else {
        out.set(path, { sha, mode });
      }
    }
  }
  flatCache.set(key, out);
  return out;
}

export function commitFiles(commitSha: string): Map<string, FileEntry> {
  const info = parseCommit(commitSha);
  if (info === undefined || info.tree === '') return new Map();
  return flatFiles(info.tree);
}

function byteCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Build a git tree object from a flat file map, nesting directories; returns its sha. */
export function buildTree(files: Map<string, FileEntry>): string {
  interface Level {
    name: string;
    mode: string;
    sha: string;
  }
  const level = new Map<string, Level>();
  const subdirs = new Map<string, Map<string, FileEntry>>();
  for (const [path, entry] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      level.set(path, { name: path, mode: entry.mode, sha: entry.sha });
    } else {
      const dir = path.slice(0, slash);
      let sub = subdirs.get(dir);
      if (sub === undefined) {
        sub = new Map();
        subdirs.set(dir, sub);
      }
      sub.set(path.slice(slash + 1), entry);
    }
  }
  for (const [dir, sub] of subdirs) {
    level.set(dir, { name: dir, mode: '40000', sha: buildTree(sub) });
  }
  // Git sorts tree entries by name bytes, directories compared as name + '/'.
  const entries = [...level.values()].sort((a, b) =>
    byteCmp(a.name + (a.mode === '40000' ? '/' : ''), b.name + (b.mode === '40000' ? '/' : '')),
  );
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'), Buffer.from(e.sha, 'hex'));
  }
  return putObject('tree', Buffer.concat(parts));
}

/** Create a commit object with the trial's fixed identity and time; returns its sha. */
export function makeCommit(tree: string, parents: readonly string[], message: string): string {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${IDENTITY} ${GIT_DATE}`, `committer ${IDENTITY} ${GIT_DATE}`, '', `${message}\n`);
  return putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** Every commit reachable from sha, including sha itself. */
export function ancestors(sha: string): Set<string> {
  const seen = new Set<string>();
  const stack = [sha];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    const info = parseCommit(cur);
    if (info === undefined) continue;
    seen.add(cur);
    for (const p of info.parents) stack.push(p);
  }
  return seen;
}

export function isAncestor(a: string, b: string): boolean {
  return a === b || ancestors(b).has(a);
}

/** The nearest common ancestor of two commits, or null when histories are unrelated. */
export function mergeBase(a: string, b: string): string | null {
  const left = ancestors(a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (left.has(cur)) return cur;
    const info = parseCommit(cur);
    if (info !== undefined) for (const p of info.parents) queue.push(p);
  }
  return null;
}

export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

/** Diff two flat file maps: what changed going from old to new. */
export function diffFiles(oldFiles: Map<string, FileEntry>, newFiles: Map<string, FileEntry>): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, entry] of newFiles) {
    const before = oldFiles.get(path);
    if (before === undefined) {
      const obj = getObject(entry.sha);
      changes.push({ path, status: 'added', additions: obj ? lineCount(obj.data) : 0, deletions: 0 });
    } else if (before.sha !== entry.sha) {
      const a = getObject(before.sha);
      const b = getObject(entry.sha);
      changes.push({
        path,
        status: 'modified',
        additions: b ? lineCount(b.data) : 0,
        deletions: a ? lineCount(a.data) : 0,
      });
    }
  }
  for (const [path, entry] of oldFiles) {
    if (!newFiles.has(path)) {
      const obj = getObject(entry.sha);
      changes.push({ path, status: 'removed', additions: 0, deletions: obj ? lineCount(obj.data) : 0 });
    }
  }
  changes.sort((a, b) => byteCmp(a.path, b.path));
  return changes;
}

// ---------------------------------------------------------------- repositories

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface Repo {
  name: string;
  databaseId: number;
  private: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  createdAt: string;
}

export const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextPullId = 1;
let nextLabelId = 1;

export function createRepo(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    name,
    databaseId: nextRepoId++,
    private: isPrivate,
    description,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
    createdAt: NOW_ISO,
  };
  repos.set(name, repo);
  return repo;
}

export function newIssueId(): number {
  return nextIssueId++;
}
export function newCommentId(): number {
  return nextCommentId++;
}
export function newPullId(): number {
  return nextPullId++;
}
export function newLabelId(): number {
  return nextLabelId++;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Opaque, stable global ids for GraphQL and MCP parity. */
export function gid(kind: string, id: string | number): string {
  return Buffer.from(`001:${kind}${id}`, 'utf8').toString('base64');
}

export function parseGid(nodeId: string): { kind: string; id: string } | null {
  try {
    const text = Buffer.from(nodeId, 'base64').toString('utf8');
    const m = /^001:([A-Za-z]+)(.+)$/.exec(text);
    if (m === null) return null;
    return { kind: m[1], id: m[2] };
  } catch {
    return null;
  }
}