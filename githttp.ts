// Git smart HTTP: the v2 capability advertisement, ls-refs and fetch (with shallow and
// deepen semantics), the v0 fallback, and receive-pack v0 with per-ref fast-forward
// validation and a sideband report-status. Responses that depend only on the repo's git
// state are cached as whole wire buffers keyed by a version counter, so repeated clones
// of the same tip answer from memory.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DELIM,
  FLUSH,
  ZERO_OID,
  buildTree,
  collectReachable,
  decodePkts,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pkt,
  readPack,
  sidebandPack,
  writePack,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface GitContext {
  store: Store;
  repo: Repo;
  req: IncomingMessage;
  res: ServerResponse;
  body: Buffer;
  query: URLSearchParams;
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

function gitError(ctx: GitContext, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ message }), 'utf8');
  send(ctx.res, status, 'application/json; charset=utf-8', body);
}

function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The refs a advertisement lists, in a stable order: HEAD, heads, tags (with peeled). */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') entry.peeled = peelToCommit(oid, lookupOf(repo));
    }
    out.push(entry);
  }
  return out;
}

function headTip(repo: Repo): string | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// ---------------------------------------------------------------- advertisements

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow thin-pack ofs-delta no-progress\n'),
    pkt('object-format=sha1\n'),
    pkt(`agent=${AGENT}\n`),
    FLUSH,
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const tip = headTip(repo);
  const symref = tip !== undefined ? ` symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
  if (repo.refs.size === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${caps}${symref}\n`));
  } else {
    let first = true;
    if (tip !== undefined) {
      parts.push(pkt(`${tip} HEAD\u0000${caps}${symref}\n`));
      first = false;
    }
    for (const ref of advertisedRefs(repo)) {
      const suffix = first ? `\u0000${caps}${symref}` : '';
      parts.push(pkt(`${ref.oid} ${ref.name}${suffix}\n`));
      first = false;
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function cachedAdvertisement(repo: Repo, key: string, build: () => Buffer): Buffer {
  const hit = repo.cache.get(key);
  if (hit !== undefined) return hit;
  const built = build();
  repo.cache.set(key, built);
  return built;
}

// ---------------------------------------------------------------- ls-refs

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const key = `ls:${args.peel ? 1 : 0}:${args.symrefs ? 1 : 0}:${args.unborn ? 1 : 0}:${args.prefixes.join('|')}`;
  const hit = repo.cache.get(key);
  if (hit !== undefined) return hit;
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const tip = headTip(repo);
  if (matches('HEAD')) {
    if (tip !== undefined) {
      parts.push(pkt(`${tip} HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    } else if (args.unborn) {
      parts.push(pkt(`unborn HEAD${args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  const built = Buffer.concat(parts);
  repo.cache.set(key, built);
  return built;
}

// ---------------------------------------------------------------- fetch planning

/** The tree closure of a commit's tree: trees and blobs, never following parents. */
function treeClosure(treeOid: string, lookup: (oid: string) => GitObject | undefined, out: Set<string>): void {
  const queue = [treeOid];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (out.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') continue;
    out.add(oid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
}

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Plan a fetch: the objects to send, and the shallow boundary moves. `depth` (deepen N)
 * counts generations from the want tips; the client's haves are never re-sent. */
function planFetch(repo: Repo, wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const lookup = lookupOf(repo);
  const exclude = collectReachable(haves, lookup, true);
  const send = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  if (depth !== null) {
    const visited = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const want of wants) {
      const object = lookup(want);
      if (object === undefined) continue;
      if (object.type === 'tag') {
        send.add(want);
        queue.push([peelToCommit(want, lookup), 1]);
      } else if (object.type === 'commit') {
        queue.push([want, 1]);
      } else {
        send.add(want);
      }
    }
    while (queue.length > 0) {
      const [oid, d] = queue.shift() as [string, number];
      const known = visited.get(oid);
      if (known !== undefined && known <= d) continue;
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      visited.set(oid, d);
      send.add(oid);
      treeClosure(parseCommit(object.data).tree, lookup, send);
      const parents = parseCommit(object.data).parents;
      if (d < depth) {
        for (const parent of parents) queue.push([parent, d + 1]);
      } else if (parents.length > 0) {
        shallow.push(oid);
      }
    }
    for (const boundary of clientShallow) {
      const d = visited.get(boundary);
      if (d === undefined) continue;
      const object = lookup(boundary);
      const isRoot = object !== undefined && object.type === 'commit' && parseCommit(object.data).parents.length === 0;
      if (d < depth || isRoot) unshallow.push(boundary);
    }
  } else {
    for (const oid of collectReachable(wants, lookup, true)) send.add(oid);
  }

  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    if (exclude.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) objects.push(object);
  }
  return { objects, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

function fetchCacheKey(wants: string[], haves: string[], clientShallow: string[], depth: number | null, done: boolean): string {
  return `f:${depth ?? '-'}:${done ? 1 : 0}:${[...wants].sort().join(',')}:${[...haves].sort().join(',')}:${[...clientShallow].sort().join(',')}`;
}

/** The framed v2 fetch response: acknowledgments, shallow-info, then the sideband packfile. */
function v2FetchResponse(plan: FetchPlan, haves: string[], repo: Repo, done: boolean): Buffer {
  const parts: Buffer[] = [pkt('acknowledgments\n')];
  if (!done) {
    for (const have of haves) if (repo.objects.has(have)) parts.push(pkt(`ACK ${have}\n`));
  }
  parts.push(pkt('NAK\n'), FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  if (plan.objects.length > 0) {
    parts.push(pkt('packfile\n'));
    parts.push(...sidebandPack(writePack(plan.objects)));
    parts.push(FLUSH);
  }
  return Buffer.concat(parts);
}

/** The framed v0 fetch response: shallow lines, NAK, then sideband pack data. */
function v0FetchResponse(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  if (plan.objects.length > 0) parts.push(...sidebandPack(writePack(plan.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim().split(' ')[0] as string;
      if (isOid(oid)) args.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) args.depth = value;
    } else if (line === 'done') {
      args.done = true;
    }
  }
  return args;
}

function handleUploadPack(ctx: GitContext): void {
  const { repo, body, res } = ctx;
  let decoded;
  try {
    decoded = decodePkts(body, true);
  } catch {
    gitError(ctx, 400, 'malformed pkt-line stream');
    return;
  }
  const lines: string[] = [];
  for (const packet of decoded.packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  if (lines.length === 0) {
    gitError(ctx, 400, 'empty upload-pack request');
    return;
  }

  if (lines[0] === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    // After the command line come capability lines (agent, object-format), a delimiter,
    // then the arguments. Only the argument keywords matter; anything else is ignored.
    for (const line of lines.slice(1)) {
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
    }
    send(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
    return;
  }

  if (lines[0] === 'command=fetch') {
    const args = parseFetchArgs(lines.slice(1));
    if (args.wants.length === 0) {
      send(res, 200, 'application/x-git-upload-pack-result', Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]));
      return;
    }
    const key = fetchCacheKey(args.wants, args.haves, args.shallow, args.depth, args.done);
    const hit = repo.cache.get(key);
    if (hit !== undefined) {
      send(res, 200, 'application/x-git-upload-pack-result', hit);
      return;
    }
    let plan: FetchPlan;
    try {
      plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
    } catch (err) {
      gitError(ctx, 400, err instanceof Error ? err.message : 'fetch failed');
      return;
    }
    const response = v2FetchResponse(plan, args.haves, repo, args.done);
    repo.cache.set(key, response);
    send(res, 200, 'application/x-git-upload-pack-result', response);
    return;
  }

  // v0: want lines (first carries capabilities), shallow/deepen, flush, have lines, done.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let done = false;
  let section: 'wants' | 'haves' = 'wants';
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') {
      if (section === 'wants') section = 'haves';
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      if (isOid(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) haves.push(oid);
    } else if (line === 'done') {
      done = true;
    }
  }
  if (wants.length === 0) {
    gitError(ctx, 400, 'fetch needs at least one want');
    return;
  }
  let plan: FetchPlan;
  try {
    plan = planFetch(repo, wants, haves, shallow, depth);
  } catch (err) {
    gitError(ctx, 400, err instanceof Error ? err.message : 'fetch failed');
    return;
  }
  send(res, 200, 'application/x-git-upload-pack-result', v0FetchResponse(plan));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(ctx: GitContext): void {
  const { repo, body, res, store } = ctx;
  let decoded;
  try {
    decoded = decodePkts(body, true);
  } catch {
    gitError(ctx, 400, 'malformed pkt-line stream');
    return;
  }
  const commands: PushCommand[] = [];
  let clientCaps = '';
  let sawFlush = false;
  for (const packet of decoded.packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      clientCaps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length !== 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) continue;
    commands.push({ oldOid, newOid, ref });
  }
  const sideband = clientCaps.includes('side-band-64k');

  // Unpack the packfile (the bytes after the command list's flush), storing every object
  // even when a ref update will be refused: a refused push still unpacks.
  let unpackDetail = 'ok';
  const packBytes = sawFlush ? decoded.rest : Buffer.alloc(0);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, lookupOf(repo));
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  // Evaluate every command against the pre-push ref state, then apply the accepted ones.
  const reports: Array<{ ref: string; ok: boolean; reason: string }> = [];
  const apply: Array<{ ref: string; oid: string | null }> = [];
  if (unpackDetail !== 'ok') {
    for (const command of commands) reports.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        if (current === undefined) reports.push({ ref: command.ref, ok: false, reason: 'ref not found' });
        else if (current !== command.oldOid) reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
        else {
          reports.push({ ref: command.ref, ok: true, reason: '' });
          apply.push({ ref: command.ref, oid: null });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reports.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reports.push({ ref: command.ref, ok: false, reason: 'already exists' });
        else {
          reports.push({ ref: command.ref, ok: true, reason: '' });
          apply.push({ ref: command.ref, oid: command.newOid });
        }
        continue;
      }
      if (current === undefined) reports.push({ ref: command.ref, ok: false, reason: 'ref not found' });
      else if (current !== command.oldOid) reports.push({ ref: command.ref, ok: false, reason: 'stale info' });
      else if (!isAncestor(current, command.newOid, lookupOf(repo))) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        reports.push({ ref: command.ref, ok: true, reason: '' });
        apply.push({ ref: command.ref, oid: command.newOid });
      }
    }
  }
  if (apply.length > 0) {
    for (const update of apply) {
      if (update.oid === null) repo.refs.delete(update.ref);
      else repo.refs.set(update.ref, update.oid);
    }
    store.touchGit(repo);
  }

  const reportLines: Buffer[] = [pkt(`unpack ${unpackDetail}\n`)];
  for (const report of reports) {
    reportLines.push(pkt(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`));
  }
  reportLines.push(FLUSH);
  const reportBytes = Buffer.concat(reportLines);
  const response = sideband
    ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), reportBytes])), FLUSH])
    : reportBytes;
  send(res, 200, 'application/x-git-receive-pack-result', response);
}

// ---------------------------------------------------------------- the route

/** Serve one git smart-HTTP request. The repo exists (the router checked) and auth passed. */
export function handleGit(ctx: GitContext, suffix: string): void {
  const { req, res, repo, query } = ctx;
  const method = req.method ?? 'GET';
  if (suffix === 'info/refs' && method === 'GET') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      gitError(ctx, 404, 'unknown service');
      return;
    }
    const protocolHeader = (req.headers['git-protocol'] as string | undefined) ?? '';
    const wantsV2 = service === 'git-upload-pack' && /version=2/.test(protocolHeader);
    if (wantsV2) {
      send(res, 200, 'application/x-git-upload-pack-advertisement', cachedAdvertisement(repo, 'adv:v2', v2Advertisement));
      return;
    }
    const key = service === 'git-upload-pack' ? 'adv:v0:upload' : 'adv:v0:receive';
    const body = cachedAdvertisement(repo, key, () => v0Advertisement(repo, service));
    send(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }
  if (suffix === 'git-upload-pack' && method === 'POST') {
    handleUploadPack(ctx);
    return;
  }
  if (suffix === 'git-receive-pack' && method === 'POST') {
    handleReceivePack(ctx);
    return;
  }
  gitError(ctx, 404, 'not found');
}

/** Store a blob and commit a tree change on a branch (the contents API's git side).
 * Returns the new commit oid, or null when the branch tip is missing and creation is not allowed. */
export function commitTreeChange(
  repo: Repo,
  store: Store,
  branch: string,
  treeOid: string,
  message: string,
  timestamp: number,
  author: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const commit = buildCommit({
    tree: treeOid,
    parents: parent === undefined ? [] : [parent],
    message,
    author,
    committer: author,
    timestamp,
  });
  const oid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, oid);
  store.touchGit(repo);
  return oid;
}

/** Build a tree object from entries and store it. */
export function storeTree(repo: Repo, entries: Parameters<typeof buildTree>[0]): string {
  return putObject(repo, 'tree', buildTree(entries));
}

export { putObject, lookupOf };
