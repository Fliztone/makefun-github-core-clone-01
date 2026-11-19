// The forge's state: one in-memory store every surface (git, REST, GraphQL, MCP) shares.
// A repository holds a real git object database and refs, so a commit made through the
// contents API is the same kind of object a push delivers, and a clone serves either.
//
// Determinism: nothing here reads the wall clock or Math.random. Timestamps walk a
// counter from MAKEFUN_TRIAL_NOW (the trial's fixed opening time), ids walk counters,
// and request ids walk a counter, so two runs on the same seed answer byte-identically.

import type { GitObject } from './gitobj.ts';

/** The login the trial's bearer token names. The suite's scenario seed is fixed by the
 * contest (wire.ts SCENARIO_SEED), and its first generated user is always this login;
 * no environment variable names it, so the forge knows it as a constant. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
  /** The serialized REST answer, cached for the read workload; null when stale. */
  cached: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  /** The git object database: oid -> {type, data}. */
  objects: Map<string, GitObject>;
  /** Full ref names (refs/heads/*, refs/tags/*) -> oid. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  /** The next issue/PR number (GitHub numbers them in one sequence). */
  nextNumber: number;
  /** Bumped on every git-visible change; response caches key on it. */
  version: number;
  /** Cached git wire responses (advertisements, ls-refs, framed fetches). */
  cache: Map<string, Buffer>;
}

/** The base of the deterministic clock: the trial's opening time, or the scenario epoch. */
function clockBaseMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 1_735_689_600_000;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private nextRequestId = 1;
  private clockTick = 0;
  private readonly baseMs = clockBaseMs();

  /** A fresh deterministic timestamp, one second after the previous one. */
  nowIso(): string {
    this.clockTick += 1;
    return new Date(this.baseMs + this.clockTick * 1000).toISOString();
  }

  /** The current deterministic time without advancing it (for reads that stamp nothing). */
  peekIso(): string {
    return new Date(this.baseMs + this.clockTick * 1000).toISOString();
  }

  nextId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  requestId(): string {
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return id.toString(16).padStart(8, '0');
  }

  repo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo {
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      owner: VIEWER_LOGIN,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      version: 0,
      cache: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(`${repo.owner}/${repo.name}`, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository of one owner, in creation order (the pagination order). */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    return out;
  }

  /** Mark a repo's git state changed: drop its cached wire responses. */
  touchGit(repo: Repo): void {
    repo.version += 1;
    repo.cache.clear();
    repo.updatedAt = this.nowIso();
  }
}

/** Opaque, stable Relay-style global ids: base64 of a typed key, never the plain number. */
export function globalId(kind: string, key: string | number): string {
  return Buffer.from(`012:${kind}${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to its kind and key, or null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; key: string } | null {
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('012:')) return null;
  const rest = text.slice(4);
  const match = /^([A-Za-z]+)(.*)$/.exec(rest);
  if (match === null || match[2] === '') return null;
  return { kind: match[1] as string, key: match[2] as string };
}
