// GraphQL v4 at /api/graphql: a small parser and executor for the documents gh and
// github-mcp-server send, resolving against the same store REST and MCP use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readBody, sendJson } from './forge.ts';
import {
  OWNER,
  NOW_ISO,
  type Repo,
  type Issue,
  type Pull,
  repos,
  gid,
  parseGid,
  branchTip,
  newIssueId,
  newCommentId,
  newPullId,
} from './store.ts';
import { squashMerge, pullMergeable, pullChanges } from './rest.ts';

// ---------------------------------------------------------------- the parser

interface Field {
  alias?: string;
  name: string;
  args: Record<string, unknown>;
  selections: Field[];
}

class GqlParseError extends Error {}

function parseDocument(src: string): { op: string; selections: Field[] } {
  let i = 0;
  const skip = (): void => {
    while (i < src.length && /[\s,]/.test(src[i])) i += 1;
  };
  const peek = (): string => {
    skip();
    return src[i] ?? '';
  };
  const expect = (ch: string): void => {
    skip();
    if (src[i] !== ch) throw new GqlParseError(`expected ${ch} at ${i}`);
    i += 1;
  };
  const readName = (): string => {
    skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (m === null) throw new GqlParseError(`expected a name at ${i}`);
    i += m[0].length;
    return m[0];
  };
  const parseValue = (): unknown => {
    skip();
    const c = src[i];
    if (c === '$') {
      i += 1;
      return { __var: readName() };
    }
    if (c === '"') {
      i += 1;
      let out = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          i += 1;
          const e = src[i];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
        } else {
          out += src[i];
        }
        i += 1;
      }
      i += 1;
      return out;
    }
    if (c === '[') {
      i += 1;
      const arr: unknown[] = [];
      while (peek() !== ']') arr.push(parseValue());
      expect(']');
      return arr;
    }
    if (c === '{') {
      i += 1;
      const obj: Record<string, unknown> = {};
      while (peek() !== '}') {
        const k = readName();
        expect(':');
        obj[k] = parseValue();
      }
      expect('}');
      return obj;
    }
    if (/[-0-9]/.test(c)) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i));
      if (m === null) throw new GqlParseError(`bad number at ${i}`);
      i += m[0].length;
      return Number(m[0]);
    }
    const name = readName();
    if (name === 'true') return true;
    if (name === 'false') return false;
    if (name === 'null') return null;
    return { __enum: name };
  };
  const parseArgs = (): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    if (peek() === '(') {
      i += 1;
      while (peek() !== ')') {
        const k = readName();
        expect(':');
        args[k] = parseValue();
      }
      expect(')');
    }
    return args;
  };
  const parseSelectionSet = (): Field[] => {
    expect('{');
    const fields: Field[] = [];
    while (peek() !== '}') fields.push(parseField());
    expect('}');
    return fields;
  };
  const parseField = (): Field => {
    skip();
    if (src.startsWith('...', i)) {
      i += 3;
      skip();
      if (/^on\b/.test(src.slice(i))) {
        readName();
        const typeCondition = readName();
        return { name: '__inline', args: { typeCondition }, selections: parseSelectionSet() };
      }
      return { name: '__spread', args: { fragment: readName() }, selections: [] };
    }
    let name = readName();
    let alias: string | undefined;
    if (peek() === ':') {
      i += 1;
      alias = name;
      name = readName();
    }
    const args = parseArgs();
    const selections = peek() === '{' ? parseSelectionSet() : [];
    return { alias, name, args, selections };
  };

  skip();
  let op = 'query';
  if (/^(query|mutation|subscription)\b/.test(src.slice(i))) {
    op = readName();
    skip();
    if (/[A-Za-z_]/.test(src[i] ?? '')) readName();
    if (peek() === '(') {
      let depth = 0;
      do {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') depth -= 1;
        i += 1;
      } while (depth > 0 && i < src.length);
    }
  }
  return { op, selections: parseSelectionSet() };
}

function resolveValue(value: unknown, vars: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.__var === 'string') return vars[v.__var] ?? null;
    if (typeof v.__enum === 'string') return v.__enum;
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, vars));
    const out: Record<string, unknown> = {};
    for (const [k, entry] of Object.entries(v)) out[k] = resolveValue(entry, vars);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- typed nodes

interface Node {
  __type: string;
  [key: string]: unknown;
}

function userNode(): Node {
  return { __type: 'User', id: gid('User', 1), login: OWNER, name: OWNER };
}

function repoNode(repo: Repo): Node {
  return { __type: 'Repository', repo };
}

function issueNode(issue: Issue): Node {
  return { __type: 'Issue', issue };
}

function pullNode(repo: Repo, pull: Pull): Node {
  return { __type: 'PullRequest', repo, pull };
}

function repoByGid(id: unknown): Repo | undefined {
  const parsed = parseGid(String(id ?? ''));
  if (parsed === null || parsed.kind !== 'Repository') return undefined;
  const databaseId = Number(parsed.id);
  for (const repo of repos.values()) if (repo.databaseId === databaseId) return repo;
  return undefined;
}

function issueByGid(id: unknown): { repo: Repo; issue: Issue } | undefined {
  const parsed = parseGid(String(id ?? ''));
  if (parsed === null || parsed.kind !== 'Issue') return undefined;
  const issueId = Number(parsed.id);
  for (const repo of repos.values()) {
    const issue = repo.issues.find((entry) => entry.id === issueId);
    if (issue !== undefined) return { repo, issue };
  }
  return undefined;
}

function pullByGid(id: unknown): { repo: Repo; pull: Pull } | undefined {
  const parsed = parseGid(String(id ?? ''));
  if (parsed === null || parsed.kind !== 'PullRequest') return undefined;
  const pullId = Number(parsed.id);
  for (const repo of repos.values()) {
    const pull = repo.pulls.find((entry) => entry.id === pullId);
    if (pull !== undefined) return { repo, pull };
  }
  return undefined;
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m === null ? -1 : Number(m[1]);
  } catch {
    return -1;
  }
}

function connection(nodes: Node[], start: number, first: number): Node {
  const page = nodes.slice(start, start + first);
  const hasNextPage = start + first < nodes.length;
  return {
    __type: 'Connection',
    nodes: page,
    totalCount: nodes.length,
    hasNextPage,
    hasPreviousPage: start > 0,
    startCursor: page.length > 0 ? cursorOf(start) : null,
    endCursor: page.length > 0 ? cursorOf(start + page.length - 1) : null,
  };
}

// ---------------------------------------------------------------- the schema

const SCHEMA_FIELDS: Record<string, string[]> = {
  User: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'comments', 'labels', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt', 'author', 'url',
  ],
  Ref: ['name', 'target', 'repository'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'totalCount'],
  Label: ['id', 'name', 'color'],
  IssueCommentConnection: ['totalCount'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeable: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
};

type Resolver = (source: Record<string, unknown>, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(),
    repository: (_s, args) => {
      if (args.owner !== OWNER) return null;
      const repo = repos.get(String(args.name ?? ''));
      return repo === undefined ? null : repoNode(repo);
    },
    node: (_s, args) => {
      const parsed = parseGid(String(args.id ?? ''));
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = repoByGid(args.id);
        return repo === undefined ? null : repoNode(repo);
      }
      if (parsed.kind === 'Issue') {
        const found = issueByGid(args.id);
        return found === undefined ? null : issueNode(found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = pullByGid(args.id);
        return found === undefined ? null : pullNode(found.repo, found.pull);
      }
      return null;
    },
    __type: (_s, args) => {
      const name = String(args.name ?? '');
      if (!(name in SCHEMA_FIELDS) && !(name in SCHEMA_ENUMS)) return null;
      return {
        __type: '__Type',
        name,
        fieldNames: SCHEMA_FIELDS[name] ?? [],
        enumNames: SCHEMA_ENUMS[name] ?? [],
      };
    },
  },
  Mutation: {
    createIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGid(input.repositoryId);
      if (repo === undefined) throw new HttpError(200, 'Repository not found');
      const title = String(input.title ?? '');
      if (title === '') throw new HttpError(200, 'Title is required');
      const issue: Issue = {
        id: newIssueId(),
        number: repo.nextIssue++,
        title,
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        comments: [],
        createdAt: NOW_ISO,
        closedAt: null,
      };
      repo.issues.push(issue);
      return { __type: 'CreateIssuePayload', issue: issueNode(issue) };
    },
    closeIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGid(input.issueId);
      if (found === undefined) throw new HttpError(200, 'Issue not found');
      found.issue.state = 'closed';
      found.issue.closedAt = NOW_ISO;
      return { __type: 'CloseIssuePayload', issue: issueNode(found.issue) };
    },
    createPullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = repoByGid(input.repositoryId);
      if (repo === undefined) throw new HttpError(200, 'Repository not found');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (branchTip(repo, head) === undefined || branchTip(repo, base) === undefined || head === base) {
        throw new HttpError(200, 'Head and base branches must exist and differ');
      }
      const pull: Pull = {
        id: newPullId(),
        number: repo.nextPull++,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
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
      return { __type: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = pullByGid(input.pullRequestId);
      if (found === undefined) throw new HttpError(200, 'Pull request not found');
      const outcome = squashMerge(found.repo, found.pull);
      if (!outcome.ok) throw new HttpError(200, outcome.reason);
      return { __type: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    },
    addComment: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = issueByGid(input.subjectId);
      if (found === undefined) throw new HttpError(200, 'Subject not found');
      const comment = { id: newCommentId(), body: String(input.body ?? ''), createdAt: NOW_ISO };
      found.issue.comments.push(comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: {
          __type: 'IssueCommentEdge',
          node: { __type: 'IssueComment', id: gid('IssueComment', comment.id), body: comment.body, createdAt: comment.createdAt },
        },
      };
    },
  },
  User: {
    id: (s) => s.id,
    login: (s) => s.login,
    name: (s) => s.name,
    url: () => `https://github.com/${OWNER}`,
  },
  Repository: {
    id: (s) => gid('Repository', (s.repo as Repo).databaseId),
    databaseId: (s) => (s.repo as Repo).databaseId,
    name: (s) => (s.repo as Repo).name,
    nameWithOwner: (s) => `${OWNER}/${(s.repo as Repo).name}`,
    owner: () => userNode(),
    description: (s) => (s.repo as Repo).description,
    isPrivate: (s) => (s.repo as Repo).private,
    createdAt: (s) => (s.repo as Repo).createdAt,
    updatedAt: (s) => (s.repo as Repo).createdAt,
    url: (s) => `https://github.com/${OWNER}/${(s.repo as Repo).name}`,
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    defaultBranchRef: (s) => {
      const repo = s.repo as Repo;
      const tip = branchTip(repo, repo.defaultBranch);
      if (tip === undefined) return null;
      return { __type: 'Ref', name: repo.defaultBranch, oid: tip, repo };
    },
    issue: (s, args) => {
      const repo = s.repo as Repo;
      const issue = repo.issues.find((entry) => entry.number === Number(args.number));
      return issue === undefined ? null : issueNode(issue);
    },
    issues: (s, args) => {
      const repo = s.repo as Repo;
      let list = [...repo.issues];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : [];
      if (states.length > 0) list = list.filter((entry) => states.includes(entry.state.toUpperCase()));
      const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
      const desc = orderBy !== null && String(orderBy.direction ?? 'DESC') === 'DESC';
      list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
      const first = Math.max(0, Math.min(100, Number(args.first ?? 30)));
      const start = indexOfCursor(args.after) + 1;
      return connection(list.map(issueNode), start, first);
    },
    pullRequests: (s, args) => {
      const repo = s.repo as Repo;
      let list = [...repo.pulls];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : ['OPEN'];
      if (states.length > 0) {
        list = list.filter((entry) => states.includes(entry.merged ? 'MERGED' : entry.state.toUpperCase()));
      }
      list.sort((a, b) => b.number - a.number);
      const first = Math.max(0, Math.min(100, Number(args.first ?? 30)));
      const start = indexOfCursor(args.after) + 1;
      return connection(list.map((pull) => pullNode(repo, pull)), start, first);
    },
    pullRequest: (s, args) => {
      const repo = s.repo as Repo;
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number));
      return pull === undefined ? null : pullNode(repo, pull);
    },
  },
  Ref: {
    name: (s) => s.name,
    target: (s) => ({ __type: 'GitObject', oid: s.oid }),
    repository: (s) => repoNode(s.repo as Repo),
  },
  GitObject: {
    oid: (s) => s.oid,
    id: (s) => gid('GitObject', String(s.oid)),
  },
  Issue: {
    id: (s) => gid('Issue', (s.issue as Issue).id),
    number: (s) => (s.issue as Issue).number,
    title: (s) => (s.issue as Issue).title,
    body: (s) => (s.issue as Issue).body,
    state: (s) => (s.issue as Issue).state.toUpperCase(),
    createdAt: (s) => (s.issue as Issue).createdAt,
    updatedAt: (s) => (s.issue as Issue).createdAt,
    closedAt: (s) => (s.issue as Issue).closedAt,
    author: () => userNode(),
    url: (s) => `https://github.com/${OWNER}/issues/${(s.issue as Issue).number}`,
    comments: (s) => ({ __type: 'IssueCommentConnection', totalCount: (s.issue as Issue).comments.length }),
    labels: (s) => ({
      __type: 'LabelConnection',
      totalCount: (s.issue as Issue).labels.length,
      nodes: (s.issue as Issue).labels.map((name) => ({ __type: 'Label', id: gid('Label', name), name, color: 'ededed' })),
    }),
  },
  IssueComment: {
    id: (s) => s.id,
    body: (s) => s.body,
    author: () => userNode(),
    createdAt: (s) => s.createdAt,
    updatedAt: (s) => s.createdAt,
  },
  PullRequest: {
    id: (s) => gid('PullRequest', (s.pull as Pull).id),
    number: (s) => (s.pull as Pull).number,
    title: (s) => (s.pull as Pull).title,
    body: (s) => (s.pull as Pull).body,
    state: (s) => {
      const pull = s.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (s) => (s.pull as Pull).merged,
    mergeable: (s) => pullMergeable(s.repo as Repo, s.pull as Pull),
    headRefName: (s) => (s.pull as Pull).head,
    baseRefName: (s) => (s.pull as Pull).base,
    createdAt: (s) => (s.pull as Pull).createdAt,
    updatedAt: (s) => (s.pull as Pull).createdAt,
    mergedAt: (s) => (s.pull as Pull).mergedAt,
    closedAt: (s) => (s.pull as Pull).closedAt,
    author: () => userNode(),
    url: (s) => `https://github.com/${OWNER}/pull/${(s.pull as Pull).number}`,
    files: (s, args) => {
      const changes = pullChanges(s.repo as Repo, s.pull as Pull);
      const first = Math.max(0, Math.min(100, Number(args.first ?? 30)));
      const nodes: Node[] = changes.map((change) => ({
        __type: 'PullRequestChangedFile',
        path: change.path,
        additions: change.additions,
        deletions: change.deletions,
        changeType: change.status.toUpperCase(),
      }));
      return connection(nodes, 0, first);
    },
  },
  PullRequestChangedFile: {
    path: (s) => s.path,
    additions: (s) => s.additions,
    deletions: (s) => s.deletions,
    changeType: (s) => s.changeType,
  },
  Connection: {
    nodes: (s) => s.nodes,
    totalCount: (s) => s.totalCount,
    pageInfo: (s) => ({
      __type: 'PageInfo',
      hasNextPage: s.hasNextPage,
      hasPreviousPage: s.hasPreviousPage,
      startCursor: s.startCursor,
      endCursor: s.endCursor,
    }),
  },
  IssueConnection: {
    nodes: (s) => s.nodes,
    totalCount: (s) => s.totalCount,
    pageInfo: (s) => ({ __type: 'PageInfo', hasNextPage: s.hasNextPage, hasPreviousPage: s.hasPreviousPage, startCursor: s.startCursor, endCursor: s.endCursor }),
  },
  LabelConnection: {
    nodes: (s) => s.nodes,
    totalCount: (s) => s.totalCount,
  },
  IssueCommentConnection: {
    totalCount: (s) => s.totalCount,
  },
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage,
    hasPreviousPage: (s) => s.hasPreviousPage,
    startCursor: (s) => s.startCursor,
    endCursor: (s) => s.endCursor,
  },
  Label: {
    id: (s) => s.id,
    name: (s) => s.name,
    color: (s) => s.color,
  },
  CreateIssuePayload: { issue: (s) => s.issue },
  CloseIssuePayload: { issue: (s) => s.issue },
  CreatePullRequestPayload: { pullRequest: (s) => s.pullRequest },
  MergePullRequestPayload: { pullRequest: (s) => s.pullRequest },
  AddCommentPayload: { commentEdge: (s) => s.commentEdge },
  IssueCommentEdge: { node: (s) => s.node },
  __Type: {
    name: (s) => s.name,
    fields: (s) => (s.fieldNames as string[]).map((name) => ({ __type: '__Field', name })),
    enumValues: (s) => (s.enumNames as string[]).map((name) => ({ __type: '__EnumValue', name })),
  },
  __Field: { name: (s) => s.name },
  __EnumValue: { name: (s) => s.name },
};

// ---------------------------------------------------------------- the executor

interface GqlError {
  message: string;
}

function project(value: unknown, selections: Field[], vars: Record<string, unknown>, errors: GqlError[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => project(entry, selections, vars, errors));
  if (selections.length === 0) return value;
  const node = value as Node;
  const typeName = node.__type;
  const table = RESOLVERS[typeName];
  if (table === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.name === '__inline') {
      const inner = project(value, field.selections, vars, errors);
      if (inner !== null && typeof inner === 'object') Object.assign(out, inner);
      continue;
    }
    if (field.name === '__spread') continue;
    const key = field.alias ?? field.name;
    const resolver = table[field.name];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = resolveValue(v, vars);
    let resolved: unknown;
    try {
      resolved = resolver(node, args);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = project(resolved, field.selections, vars, errors);
  }
  return out;
}

function executeOne(document: string, variables: Record<string, unknown>): { data: unknown; errors?: GqlError[] } {
  let parsed: { op: string; selections: Field[] };
  try {
    parsed = parseDocument(document);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const errors: GqlError[] = [];
  const rootType = parsed.op === 'mutation' ? 'Mutation' : 'Query';
  const data = project({ __type: rootType }, parsed.selections, variables, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const op = (entry ?? {}) as Record<string, unknown>;
      return executeOne(String(op.query ?? ''), (op.variables ?? {}) as Record<string, unknown>);
    });
    sendJson(res, 200, results);
    return;
  }
  const op = (body ?? {}) as Record<string, unknown>;
  const result = executeOne(String(op.query ?? ''), (op.variables ?? {}) as Record<string, unknown>);
  sendJson(res, 200, result);
}