// The GraphQL v4 surface at /api/graphql: a tokenizer, a recursive-descent parser for the
// operation language (variables, aliases, arguments, inline fragments, fragment spreads,
// enums, input objects, lists, null), a schema with resolvers over the same store REST
// uses, validation that names unknown fields, and the __type introspection gh probes.
// One operation answers one {data, errors} envelope; a JSON array of operations answers
// an array of envelopes in order (GitHub's batching).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  parseGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  addCommentRecord,
  createIssueRecord,
  createPullRecord,
  issueById,
  mergePullRecord,
  pullById,
  pullFiles,
  pullMergeable,
  repoById,
} from './rest.ts';

// ---------------------------------------------------------------- the language

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const isNameStart = (ch: string): boolean => /[_A-Za-z]/.test(ch);
  const isNameChar = (ch: string): boolean => /[_0-9A-Za-z]/.test(ch);
  while (pos < source.length) {
    const ch = source[pos] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      pos += 1;
      continue;
    }
    if (ch === '#') {
      while (pos < source.length && source[pos] !== '\n') pos += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', pos)) {
      tokens.push({ kind: 'punct', value: '...' });
      pos += 3;
      continue;
    }
    if ('!$():=@[]{|}'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      pos += 1;
      continue;
    }
    if (ch === '"') {
      pos += 1;
      let value = '';
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\\') {
          pos += 1;
          const esc = source[pos];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(pos + 1, pos + 5), 16));
            pos += 4;
          } else value += esc ?? '';
          pos += 1;
        } else {
          value += source[pos];
          pos += 1;
        }
      }
      pos += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(ch)) {
      let end = pos + 1;
      while (end < source.length && isNameChar(source[end] as string)) end += 1;
      tokens.push({ kind: 'name', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    if (/[-0-9]/.test(ch)) {
      let end = pos + 1;
      while (end < source.length && /[0-9]/.test(source[end] as string)) end += 1;
      let isFloat = false;
      if (source[end] === '.') {
        isFloat = true;
        end += 1;
        while (end < source.length && /[0-9]/.test(source[end] as string)) end += 1;
      }
      if (source[end] === 'e' || source[end] === 'E') {
        isFloat = true;
        end += 1;
        if (source[end] === '+' || source[end] === '-') end += 1;
        while (end < source.length && /[0-9]/.test(source[end] as string)) end += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(pos, end) });
      pos = end;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

type ValueNode =
  | { t: 'var'; name: string }
  | { t: 'lit'; v: string | number | boolean | null }
  | { t: 'enum'; v: string }
  | { t: 'list'; items: ValueNode[] }
  | { t: 'obj'; fields: Array<[string, ValueNode]> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<[string, ValueNode]>;
  selections: SelectionNode[];
}
interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string;
  selections: SelectionNode[];
}
interface SpreadNode {
  kind: 'spread';
  name: string;
}
type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(token.value)}`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== null && token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek() !== null) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        doc.operations.push({ type: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`unexpected token ${JSON.stringify(token.value)}`);
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        const name = this.peek()?.kind === 'name' ? this.expectName() : null;
        const varDefs: OperationNode['varDefs'] = [];
        if (this.atPunct('(')) {
          this.next();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            let defaultValue: ValueNode | null = null;
            if (this.atPunct('=')) {
              this.next();
              defaultValue = this.parseValue();
            }
            varDefs.push({ name: varName, defaultValue });
          }
          this.expectPunct(')');
        }
        doc.operations.push({ type: token.value, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (this.expectName() !== 'on') throw new Error('fragment needs "on"');
        const typeCondition = this.expectName();
        doc.fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected operation ${JSON.stringify(token.value)}`);
    }
    if (doc.operations.length === 0) throw new Error('the document holds no operation');
    return doc;
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek() === null) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    if (selections.length === 0) throw new Error('a selection set needs at least one selection');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      const token = this.peek();
      if (token !== null && token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token !== null && token.kind === 'name') {
        return { kind: 'spread', name: this.expectName() };
      }
      // An inline fragment without a type condition applies to the current type.
      return { kind: 'inline', typeCondition: '', selections: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<[string, ValueNode]> = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push([argName, this.parseValue()]);
      }
      this.expectPunct(')');
    }
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { t: 'var', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { t: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push([name, this.parseValue()]);
      }
      this.expectPunct('}');
      return { t: 'obj', fields };
    }
    if (token.kind === 'int') return { t: 'lit', v: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { t: 'lit', v: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { t: 'lit', v: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { t: 'lit', v: true };
      if (token.value === 'false') return { t: 'lit', v: false };
      if (token.value === 'null') return { t: 'lit', v: null };
      return { t: 'enum', v: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.t) {
    case 'var':
      return variables[node.name];
    case 'lit':
      return node.v;
    case 'enum':
      return node.v;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [name, value] of node.fields) out[name] = evalValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- the schema

interface ExecCtx {
  store: Store;
  repo: Repo | null;
  errors: Array<{ message: string }>;
}

interface FieldDef {
  type: string;
  list?: boolean;
  resolve: (parent: Record<string, unknown>, args: Record<string, unknown>, ctx: ExecCtx) => unknown;
}

interface TypeDef {
  kind: 'object' | 'enum' | 'scalar' | 'input';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
}

class GqlError extends Error {}

function argStr(args: Record<string, unknown>, name: string, fallback = ''): string {
  const value = args[name];
  return typeof value === 'string' ? value : fallback;
}

function argInt(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  if (!text.startsWith('cursor:')) return null;
  const value = Number.parseInt(text.slice(7), 10);
  return Number.isFinite(value) ? value : null;
}

function issueOrderKey(issue: Issue, field: string): number {
  if (field === 'UPDATED_AT') return Date.parse(issue.updatedAt);
  if (field === 'COMMENTS') return issue.comments.length;
  return issue.number;
}

/** The issues connection: states filter, orderBy, first/after cursor pagination. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let items = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  if (states !== null && states.length > 0) items = items.filter((issue) => states.includes(issue.state.toUpperCase()));
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  items.sort((a, b) => {
    const ka = issueOrderKey(a, field);
    const kb = issueOrderKey(b, field);
    return ka !== kb ? direction * (ka - kb) : b.number - a.number;
  });
  let start = 0;
  const afterNumber = numberOfCursor(args.after);
  if (afterNumber !== null) {
    const index = items.findIndex((issue) => issue.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const first = Math.min(100, Math.max(1, argInt(args, 'first', 30)));
  const nodes = items.slice(start, start + first);
  return {
    nodes,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorOf((nodes[0] as Issue).number) : null,
      endCursor: nodes.length > 0 ? cursorOf((nodes[nodes.length - 1] as Issue).number) : null,
    },
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let items = [...repo.pulls.values()];
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  if (states.length > 0) {
    items = items.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  items.sort((a, b) => b.number - a.number);
  const first = Math.min(100, Math.max(1, argInt(args, 'first', 30)));
  const nodes = items.slice(0, first);
  return {
    nodes,
    totalCount: items.length,
    pageInfo: { hasNextPage: first < items.length, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

function repoOfPull(ctx: ExecCtx, pull: Pull): Repo | null {
  if (ctx.repo !== null) return ctx.repo;
  const found = pullById(ctx.store, pull.id);
  return found?.repo ?? null;
}

const self = (parent: Record<string, unknown>, key: string): unknown => parent[key];

function objectField(type: string, key: string, list = false): FieldDef {
  return { type, list, resolve: (parent) => self(parent, key) };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'object',
    fields: {
      viewer: { type: 'User', resolve: () => ({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL }) },
      repository: {
        type: 'Repository',
        resolve: (_parent, args, ctx) => ctx.store.repo(argStr(args, 'owner'), argStr(args, 'name')) ?? null,
      },
      node: {
        type: 'Node',
        resolve: (_parent, args, ctx) => {
          const parsed = parseGlobalId(argStr(args, 'id'));
          if (parsed === null) return null;
          const key = Number(parsed.key);
          if (parsed.kind === 'Repository') {
            const repo = repoById(ctx.store, key);
            return repo === undefined ? null : Object.assign(repo, { __typename: 'Repository' });
          }
          if (parsed.kind === 'Issue') {
            const found = issueById(ctx.store, key);
            if (found === undefined) return null;
            ctx.repo = found.repo;
            return Object.assign(found.issue, { __typename: 'Issue' });
          }
          if (parsed.kind === 'PullRequest') {
            const found = pullById(ctx.store, key);
            if (found === undefined) return null;
            ctx.repo = found.repo;
            return Object.assign(found.pull, { __typename: 'PullRequest' });
          }
          return null;
        },
      },
      __type: {
        type: '__Type',
        resolve: (_parent, args) => introspectType(argStr(args, 'name')),
      },
      __schema: {
        type: '__Schema',
        resolve: () => ({ types: Object.keys(SCHEMA).map((name) => introspectType(name)).filter((entry) => entry !== null) }),
      },
    },
  },
  Mutation: {
    kind: 'object',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromId(ctx, input.repositoryId);
          const created = createIssueRecord(ctx.store, repo, { title: argStr(input, 'title'), body: argStr(input, 'body') });
          if ('error' in created) throw new GqlError(created.error);
          return { issue: created };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromId(ctx, input.issueId);
          found.issue.state = 'closed';
          found.issue.closedAt = ctx.store.nowIso();
          found.issue.updatedAt = ctx.store.nowIso();
          found.issue.cached = null;
          return { issue: found.issue };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoFromId(ctx, input.repositoryId);
          const created = createPullRecord(ctx.store, repo, {
            title: argStr(input, 'title'),
            body: argStr(input, 'body'),
            head: argStr(input, 'headRefName'),
            base: argStr(input, 'baseRefName'),
          });
          if ('error' in created) throw new GqlError(created.error);
          return { pullRequest: created };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = pullFromId(ctx, input.pullRequestId);
          const method = argStr(input, 'mergeMethod', 'MERGE').toLowerCase();
          const result = mergePullRecord(found.repo, ctx.store, found.pull, method, undefined);
          if ('status' in result) throw new GqlError(result.message);
          return { pullRequest: found.pull };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_parent, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueFromId(ctx, input.subjectId);
          const comment = addCommentRecord(ctx.store, found.repo, found.issue, argStr(input, 'body'));
          return { commentEdge: { node: comment } };
        },
      },
    },
  },
  Node: { kind: 'object', fields: { id: { type: 'ID', resolve: (parent) => nodeIdOf(parent) } } },
  User: {
    kind: 'object',
    fields: {
      login: objectField('String', 'login'),
      id: { type: 'ID', resolve: () => globalId('User', VIEWER_ID) },
      name: objectField('String', 'name'),
      email: objectField('String', 'email'),
    },
  },
  Repository: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (parent) => globalId('Repository', (parent as unknown as Repo).id) },
      databaseId: { type: 'Int', resolve: (parent) => (parent as unknown as Repo).id },
      name: { type: 'String', resolve: (parent) => (parent as unknown as Repo).name },
      nameWithOwner: { type: 'String', resolve: (parent) => `${(parent as unknown as Repo).owner}/${(parent as unknown as Repo).name}` },
      description: { type: 'String', resolve: (parent) => (parent as unknown as Repo).description },
      isPrivate: { type: 'Boolean', resolve: (parent) => (parent as unknown as Repo).private },
      owner: { type: 'User', resolve: (parent) => ({ login: (parent as unknown as Repo).owner }) },
      defaultBranchRef: { type: 'Ref', resolve: (parent) => ({ name: (parent as unknown as Repo).defaultBranch }) },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      issue: {
        type: 'Issue',
        resolve: (parent, args) => (parent as unknown as Repo).issues.get(argInt(args, 'number', -1)) ?? null,
      },
      issues: { type: 'IssueConnection', resolve: (parent, args) => issuesConnection(parent as unknown as Repo, args) },
      pullRequests: { type: 'PullRequestConnection', resolve: (parent, args) => pullsConnection(parent as unknown as Repo, args) },
      pullRequest: {
        type: 'PullRequest',
        resolve: (parent, args) => (parent as unknown as Repo).pulls.get(argInt(args, 'number', -1)) ?? null,
      },
      createdAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Repo).createdAt },
      updatedAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Repo).updatedAt },
    },
  },
  Ref: {
    kind: 'object',
    fields: { name: objectField('String', 'name') },
  },
  Issue: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (parent) => globalId('Issue', (parent as unknown as Issue).id) },
      number: { type: 'Int', resolve: (parent) => (parent as unknown as Issue).number },
      title: { type: 'String', resolve: (parent) => (parent as unknown as Issue).title },
      body: { type: 'String', resolve: (parent) => (parent as unknown as Issue).body },
      state: { type: 'IssueState', resolve: (parent) => (parent as unknown as Issue).state.toUpperCase() },
      createdAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Issue).createdAt },
      updatedAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Issue).updatedAt },
      closedAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Issue).closedAt },
      author: { type: 'User', resolve: () => ({ login: VIEWER_LOGIN }) },
      labels: {
        type: 'LabelConnection',
        resolve: (parent, _args, ctx) => ({
          nodes: (parent as unknown as Issue).labels.map((name) => ({ name, color: ctx.repo?.labels.get(name)?.color ?? 'ededed' })),
        }),
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (parent) => ({ nodes: (parent as unknown as Issue).comments }),
      },
    },
  },
  IssueConnection: {
    kind: 'object',
    fields: {
      nodes: { type: 'Issue', list: true, resolve: (parent) => parent.nodes },
      totalCount: objectField('Int', 'totalCount'),
      pageInfo: { type: 'PageInfo', resolve: (parent) => parent.pageInfo },
    },
  },
  PullRequestConnection: {
    kind: 'object',
    fields: {
      nodes: { type: 'PullRequest', list: true, resolve: (parent) => parent.nodes },
      totalCount: objectField('Int', 'totalCount'),
      pageInfo: { type: 'PageInfo', resolve: (parent) => parent.pageInfo },
    },
  },
  LabelConnection: {
    kind: 'object',
    fields: { nodes: { type: 'Label', list: true, resolve: (parent) => parent.nodes } },
  },
  IssueCommentConnection: {
    kind: 'object',
    fields: { nodes: { type: 'IssueComment', list: true, resolve: (parent) => parent.nodes } },
  },
  Label: {
    kind: 'object',
    fields: { name: objectField('String', 'name'), color: objectField('String', 'color') },
  },
  IssueComment: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (parent) => globalId('IssueComment', (parent as unknown as { id: number }).id) },
      body: objectField('String', 'body'),
      createdAt: objectField('DateTime', 'createdAt'),
      updatedAt: objectField('DateTime', 'updatedAt'),
      author: { type: 'User', resolve: () => ({ login: VIEWER_LOGIN }) },
    },
  },
  PullRequest: {
    kind: 'object',
    fields: {
      id: { type: 'ID', resolve: (parent) => globalId('PullRequest', (parent as unknown as Pull).id) },
      number: { type: 'Int', resolve: (parent) => (parent as unknown as Pull).number },
      title: { type: 'String', resolve: (parent) => (parent as unknown as Pull).title },
      body: { type: 'String', resolve: (parent) => (parent as unknown as Pull).body },
      state: { type: 'PullRequestState', resolve: (parent) => ((parent as unknown as Pull).merged ? 'MERGED' : (parent as unknown as Pull).state.toUpperCase()) },
      merged: { type: 'Boolean', resolve: (parent) => (parent as unknown as Pull).merged },
      mergedAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Pull).mergedAt },
      headRefName: { type: 'String', resolve: (parent) => (parent as unknown as Pull).headRef },
      baseRefName: { type: 'String', resolve: (parent) => (parent as unknown as Pull).baseRef },
      mergeable: {
        type: 'MergeableState',
        resolve: (parent, _args, ctx) => {
          const repo = repoOfPull(ctx, parent as unknown as Pull);
          return repo === null ? 'UNKNOWN' : pullMergeable(repo, parent as unknown as Pull);
        },
      },
      mergeCommit: {
        type: 'Commit',
        resolve: (parent) => {
          const pull = parent as unknown as Pull;
          return pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha };
        },
      },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (parent, args, ctx) => {
          const repo = repoOfPull(ctx, parent as unknown as Pull);
          if (repo === null) return { nodes: [] };
          const first = Math.min(100, Math.max(1, argInt(args, 'first', 30)));
          const files = pullFiles(repo, parent as unknown as Pull).slice(0, first);
          return { nodes: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions })) };
        },
      },
      createdAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Pull).createdAt },
      updatedAt: { type: 'DateTime', resolve: (parent) => (parent as unknown as Pull).updatedAt },
      author: { type: 'User', resolve: () => ({ login: VIEWER_LOGIN }) },
    },
  },
  Commit: { kind: 'object', fields: { oid: objectField('GitObjectID', 'oid') } },
  PullRequestChangedFileConnection: {
    kind: 'object',
    fields: { nodes: { type: 'PullRequestChangedFile', list: true, resolve: (parent) => parent.nodes } },
  },
  PullRequestChangedFile: {
    kind: 'object',
    fields: {
      path: objectField('String', 'path'),
      additions: objectField('Int', 'additions'),
      deletions: objectField('Int', 'deletions'),
    },
  },
  PageInfo: {
    kind: 'object',
    fields: {
      hasNextPage: objectField('Boolean', 'hasNextPage'),
      hasPreviousPage: objectField('Boolean', 'hasPreviousPage'),
      startCursor: objectField('String', 'startCursor'),
      endCursor: objectField('String', 'endCursor'),
    },
  },
  CreateIssuePayload: { kind: 'object', fields: { issue: { type: 'Issue', resolve: (parent) => parent.issue } } },
  CloseIssuePayload: { kind: 'object', fields: { issue: { type: 'Issue', resolve: (parent) => parent.issue } } },
  CreatePullRequestPayload: { kind: 'object', fields: { pullRequest: { type: 'PullRequest', resolve: (parent) => parent.pullRequest } } },
  MergePullRequestPayload: { kind: 'object', fields: { pullRequest: { type: 'PullRequest', resolve: (parent) => parent.pullRequest } } },
  AddCommentPayload: { kind: 'object', fields: { commentEdge: { type: 'CommentEdge', resolve: (parent) => parent.commentEdge } } },
  CommentEdge: { kind: 'object', fields: { node: { type: 'IssueComment', resolve: (parent) => parent.node } } },
  __Type: {
    kind: 'object',
    fields: {
      name: objectField('String', 'name'),
      kind: objectField('String', 'kind'),
      description: objectField('String', 'description'),
      fields: { type: '__Field', list: true, resolve: (parent) => parent.fields ?? null },
      enumValues: { type: '__EnumValue', list: true, resolve: (parent) => parent.enumValues ?? null },
    },
  },
  __Field: {
    kind: 'object',
    fields: {
      name: objectField('String', 'name'),
      description: objectField('String', 'description'),
      isDeprecated: objectField('Boolean', 'isDeprecated'),
      args: { type: '__InputValue', list: true, resolve: (parent) => parent.args ?? [] },
      type: { type: '__TypeRef', resolve: (parent) => parent.type ?? null },
    },
  },
  __InputValue: { kind: 'object', fields: { name: objectField('String', 'name') } },
  __EnumValue: {
    kind: 'object',
    fields: {
      name: objectField('String', 'name'),
      description: objectField('String', 'description'),
      isDeprecated: objectField('Boolean', 'isDeprecated'),
    },
  },
  __TypeRef: {
    kind: 'object',
    fields: { name: objectField('String', 'name'), kind: objectField('String', 'kind'), ofType: { type: '__TypeRef', resolve: (parent) => parent.ofType ?? null } },
  },
  __Schema: { kind: 'object', fields: { types: { type: '__Type', list: true, resolve: (parent) => parent.types } } },
  IssueState: { kind: 'enum', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'enum', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'enum', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'enum', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'enum', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'enum', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'enum', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'enum', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'ORGANIZATION', 'TEAM', 'COMMIT'] },
  String: { kind: 'scalar' },
  Int: { kind: 'scalar' },
  ID: { kind: 'scalar' },
  Boolean: { kind: 'scalar' },
  DateTime: { kind: 'scalar' },
  GitObjectID: { kind: 'scalar' },
  URI: { kind: 'scalar' },
};

function nodeIdOf(parent: Record<string, unknown>): unknown {
  const typename = parent.__typename;
  if (typename === 'Repository') return globalId('Repository', (parent as unknown as Repo).id);
  if (typename === 'Issue') return globalId('Issue', (parent as unknown as Issue).id);
  if (typename === 'PullRequest') return globalId('PullRequest', (parent as unknown as Pull).id);
  return parent.id ?? null;
}

function repoFromId(ctx: ExecCtx, id: unknown): Repo {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  const repo = parsed !== null && parsed.kind === 'Repository' ? repoById(ctx.store, Number(parsed.key)) : undefined;
  if (repo === undefined) throw new GqlError('Could not resolve to a Repository with the given id.');
  return repo;
}

function issueFromId(ctx: ExecCtx, id: unknown): { repo: Repo; issue: Issue } {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  const found = parsed !== null && parsed.kind === 'Issue' ? issueById(ctx.store, Number(parsed.key)) : undefined;
  if (found === undefined) throw new GqlError('Could not resolve to an Issue with the given id.');
  return found;
}

function pullFromId(ctx: ExecCtx, id: unknown): { repo: Repo; pull: Pull } {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  const found = parsed !== null && parsed.kind === 'PullRequest' ? pullById(ctx.store, Number(parsed.key)) : undefined;
  if (found === undefined) throw new GqlError('Could not resolve to a PullRequest with the given id.');
  return found;
}

function introspectType(name: string): Record<string, unknown> | null {
  const def = SCHEMA[name];
  if (def === undefined) return null;
  const kind = def.kind === 'object' ? 'OBJECT' : def.kind === 'enum' ? 'ENUM' : def.kind === 'input' ? 'INPUT_OBJECT' : 'SCALAR';
  const typeRef = (field: FieldDef): Record<string, unknown> => {
    const inner = SCHEMA[field.type];
    const innerKind = inner === undefined ? 'SCALAR' : inner.kind === 'object' ? 'OBJECT' : inner.kind === 'enum' ? 'ENUM' : 'SCALAR';
    if (field.list === true) return { name: null, kind: 'LIST', ofType: { name: field.type, kind: innerKind, ofType: null } };
    return { name: field.type, kind: innerKind, ofType: null };
  };
  return {
    name,
    kind,
    description: '',
    fields:
      def.kind === 'object' && def.fields !== undefined
        ? Object.entries(def.fields).map(([fieldName, field]) => ({
            name: fieldName,
            description: '',
            isDeprecated: false,
            args: [],
            type: typeRef(field),
          }))
        : null,
    enumValues: def.kind === 'enum' ? (def.enumValues ?? []).map((value) => ({ name: value, description: '', isDeprecated: false })) : null,
  };
}

// ---------------------------------------------------------------- validation and execution

function concreteType(type: string, parent: Record<string, unknown> | null): string {
  if (type === 'Node' && parent !== null && typeof parent.__typename === 'string') return parent.__typename;
  return type;
}

function validateSelections(type: string, selections: SelectionNode[], doc: DocumentNode, errors: Array<{ message: string }>): void {
  const def = SCHEMA[type];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const target = selection.typeCondition === '' ? type : selection.typeCondition;
      if (SCHEMA[target] === undefined) {
        errors.push({ message: `Unknown type ${JSON.stringify(target)}.` });
        continue;
      }
      validateSelections(target, selection.selections, doc, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push({ message: `Unknown fragment ${JSON.stringify(selection.name)}.` });
        continue;
      }
      validateSelections(fragment.typeCondition, fragment.selections, doc, errors);
      continue;
    }
    if (selection.name === '__typename') continue;
    const field = def?.fields?.[selection.name];
    if (field === undefined) {
      errors.push({ message: `Cannot query field ${JSON.stringify(selection.name)} on type ${JSON.stringify(type)}.` });
      continue;
    }
    if (selection.selections.length > 0) validateSelections(field.type, selection.selections, doc, errors);
  }
}

function executeSelections(type: string, parent: Record<string, unknown> | null, selections: SelectionNode[], doc: DocumentNode, variables: Record<string, unknown>, ctx: ExecCtx): Record<string, unknown> | null {
  if (parent === null) return null;
  const effective = concreteType(type, parent);
  if (effective === 'Repository') ctx.repo = parent as unknown as Repo;
  const def = SCHEMA[effective];
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      const target = selection.typeCondition === '' ? effective : selection.typeCondition;
      if (target === effective || selection.typeCondition === '') {
        const nested = executeSelections(target, parent, selection.selections, doc, variables, ctx);
        if (nested !== null) Object.assign(out, nested);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = doc.fragments.get(selection.name);
      if (fragment !== undefined && fragment.typeCondition === effective) {
        const nested = executeSelections(fragment.typeCondition, parent, fragment.selections, doc, variables, ctx);
        if (nested !== null) Object.assign(out, nested);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = effective;
      continue;
    }
    const field = def?.fields?.[selection.name];
    if (field === undefined) continue;
    const args: Record<string, unknown> = {};
    for (const [name, value] of selection.args) args[name] = evalValue(value, variables);
    let value: unknown;
    try {
      value = field.resolve(parent, args, ctx);
    } catch (err) {
      if (err instanceof GqlError) {
        ctx.errors.push({ message: err.message });
        out[key] = null;
        continue;
      }
      throw err;
    }
    if (selection.selections.length === 0) {
      out[key] = value ?? null;
      continue;
    }
    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }
    if (field.list === true) {
      const items = Array.isArray(value) ? value : [];
      out[key] = items.map((item) => executeSelections(field.type, (item ?? null) as Record<string, unknown> | null, selection.selections, doc, variables, ctx));
    } else {
      out[key] = executeSelections(field.type, value as Record<string, unknown>, selection.selections, doc, variables, ctx);
    }
  }
  return out;
}

/** Execute one operation document against the store. */
export function executeGraphql(store: Store, query: string, variables: Record<string, unknown>, operationName?: string): { data: unknown; errors?: Array<{ message: string }> } {
  let doc: DocumentNode;
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  let operation = doc.operations[0] as OperationNode;
  if (operationName !== undefined && operationName !== '') {
    const named = doc.operations.find((candidate) => candidate.name === operationName);
    if (named === undefined) return { data: null, errors: [{ message: `Unknown operation named ${JSON.stringify(operationName)}.` }] };
    operation = named;
  }
  const coerced: Record<string, unknown> = { ...variables };
  for (const varDef of operation.varDefs) {
    if (coerced[varDef.name] === undefined && varDef.defaultValue !== null) {
      coerced[varDef.name] = evalValue(varDef.defaultValue, coerced);
    }
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validateSelections(rootType, operation.selections, doc, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const ctx: ExecCtx = { store, repo: null, errors: [] };
  try {
    const data = executeSelections(rootType, {}, operation.selections, doc, coerced, ctx);
    if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'execution failed' }] };
  }
}

// ---------------------------------------------------------------- the HTTP surface

export interface GraphqlContext {
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

export function handleGraphql(ctx: GraphqlContext): void {
  const { req, res, body, store } = ctx;
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  const runOne = (entry: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'the operation must be a JSON object' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = record.query;
    if (typeof query !== 'string' || query === '') {
      return { data: null, errors: [{ message: 'the operation needs a query string' }] };
    }
    const variables = typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables) ? (record.variables as Record<string, unknown>) : {};
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    return executeGraphql(store, query, variables, operationName);
  };
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed));
}
