// Git smart HTTP: upload-pack protocol v2 (with v0 fallback) and receive-pack v0.
// The pack protocol is implemented on node:zlib and node:crypto; no git binary anywhere.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { HttpError, readBody } from './forge.ts';
import { jsInflate } from './jsinflate.ts';
import {
  OWNER,
  type Repo,
  type ObjType,
  repos,
  objects,
  getObject,
  putObject,
  hashObject,
  parseCommit,
  isAncestor,
} from './store.ts';

const ZERO = '0000000000000000000000000000000000000000';
const AGENT = 'makefun-forge/1.0';
const PKT_MAX = 65520;
const BAND_CHUNK = 65515;

// ---------------------------------------------------------------- pkt-line codec

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new HttpError(500, 'pkt-line too large');
  const len = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len, 'ascii'), data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

/** Decode a pkt-line stream; trailing raw bytes (a pack) are returned separately. */
function decodePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const hex = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', data: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) throw new HttpError(400, 'truncated pkt-line');
    packets.push({ kind: 'data', data: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { packets, rest: buf.subarray(at) };
}

function linesOf(packets: Packet[]): string[] {
  return packets.filter((p) => p.kind === 'data').map((p) => p.data.toString('utf8').replace(/\n$/, ''));
}

function sidebandFrames(data: Buffer, band: number): Buffer[] {
  const frames: Buffer[] = [];
  for (let at = 0; at < data.length; at += BAND_CHUNK) {
    const chunk = data.subarray(at, at + BAND_CHUNK);
    frames.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return frames;
}

// ---------------------------------------------------------------- pack writing

const deflateCache = new Map<string, Buffer>();

function packEntry(type: ObjType, data: Buffer, sha: string): Buffer {
  const cached = deflateCache.get(sha);
  if (cached !== undefined) return cached;
  const typeNum = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  let size = data.length;
  const head: number[] = [(typeNum << 4) | (size & 15)];
  size >>= 4;
  while (size > 0) {
    head[head.length - 1] |= 0x80;
    head.push(size & 0x7f);
    size >>= 7;
  }
  const entry = Buffer.concat([Buffer.from(head), deflateSync(data, { level: 1 })]);
  deflateCache.set(sha, entry);
  return entry;
}

const wholePackCache = new Map<string, Buffer>();

function writePack(shas: string[]): Buffer {
  // Objects are content-addressed and immutable, so a pack is fully determined by its
  // object set: cache the whole framed pack (the clone workload reuses one pack heavily).
  const key = [...shas].sort().join(',');
  const cached = wholePackCache.get(key);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii'), u32(2), u32(shas.length)];
  for (const sha of shas) {
    const obj = getObject(sha);
    if (obj === undefined) continue;
    parts.push(packEntry(obj.type, obj.data, sha));
  }
  const body = Buffer.concat(parts);
  const pack = Buffer.concat([body, createHash('sha1').update(body).digest()]);
  if (wholePackCache.size > 2000) wholePackCache.clear();
  wholePackCache.set(key, pack);
  return pack;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

const packCache = new Map<string, Buffer>();

// ---------------------------------------------------------------- pack reading

function inflateAt(buf: Buffer, pos: number): { data: Buffer; next: number } {
  // Pack objects are zlib-wrapped: 2-byte header (CMF/FLG) + raw DEFLATE + 4-byte adler32.
  // A single-pass JS inflate gives the exact consumed length without repeated zlib calls.
  const r = jsInflate(buf, pos + 2);
  return { data: r.data, next: pos + 2 + r.consumed + 4 };
}

function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let b = buf[pos];
  let value = b & 15;
  let shift = 4;
  let at = pos + 1;
  while (b & 0x80) {
    b = buf[at];
    at += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { value, next: at };
}

function readOfs(buf: Buffer, pos: number): { value: number; next: number } {
  let b = buf[pos];
  let value = b & 0x7f;
  let at = pos + 1;
  while (b & 0x80) {
    b = buf[at];
    at += 1;
    value = ((value + 1) << 7) | (b & 0x7f);
  }
  return { value, next: at };
}

/** Delta payloads use plain 7-bit varints (unlike pack object headers). */
function readDeltaVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let b = buf[pos];
  let value = b & 0x7f;
  let shift = 7;
  let at = pos + 1;
  while (b & 0x80) {
    b = buf[at];
    at += 1;
    value |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { value, next: at };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const size = readDeltaVarint(delta, at);
  at = size.next;
  const outSize = readDeltaVarint(delta, at);
  at = outSize.next;
  if (size.value !== base.length) throw new HttpError(400, 'delta base size mismatch');
  const out: Buffer[] = [];
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let len = 0;
      if (op & 0x01) offset |= delta[at++];
      if (op & 0x02) offset |= delta[at++] << 8;
      if (op & 0x04) offset |= delta[at++] << 16;
      if (op & 0x08) offset |= delta[at++] << 24;
      if (op & 0x10) len |= delta[at++];
      if (op & 0x20) len |= delta[at++] << 8;
      if (op & 0x40) len |= delta[at++] << 16;
      if (len === 0) len = 0x10000;
      out.push(base.subarray(offset, offset + len));
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
    } else {
      throw new HttpError(400, 'invalid delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== outSize.value) throw new HttpError(400, 'delta result size mismatch');
  return result;
}

const TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Read a pack (v2/v3), resolving OFS_DELTA and REF_DELTA; returns objects by sha. */
function readPack(buf: Buffer): Map<string, { type: ObjType; data: Buffer }> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new HttpError(400, 'not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new HttpError(400, `pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const checksum = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest('hex');
  if (checksum !== buf.subarray(buf.length - 20).toString('hex')) {
    throw new HttpError(400, 'pack checksum mismatch');
  }
  const out = new Map<string, { type: ObjType; data: Buffer }>();
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    const b = buf[at];
    const typeNum = (b >> 4) & 7;
    const header = readVarint(buf, at);
    at = header.next;
    if (typeNum === 6) {
      const ofs = readOfs(buf, at);
      at = ofs.next;
      const base = byOffset.get(start - ofs.value);
      if (base === undefined) throw new HttpError(400, 'ofs-delta base not found');
      const inf = inflateAt(buf, at);
      at = inf.next;
      const data = applyDelta(base.data, inf.data);
      const sha = hashObject(base.type, data);
      const obj = { type: base.type, data };
      out.set(sha, obj);
      byOffset.set(start, obj);
    } else if (typeNum === 7) {
      const baseSha = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      const base = out.get(baseSha) ?? objects.get(baseSha);
      if (base === undefined) throw new HttpError(400, 'ref-delta base not found');
      const inf = inflateAt(buf, at);
      at = inf.next;
      const data = applyDelta(base.data, inf.data);
      const sha = hashObject(base.type, data);
      const obj = { type: base.type, data };
      out.set(sha, obj);
      byOffset.set(start, obj);
    } else {
      const type = TYPE_NAMES[typeNum];
      if (type === undefined) throw new HttpError(400, `pack object type ${typeNum}`);
      const inf = inflateAt(buf, at);
      at = inf.next;
      if (inf.data.length !== header.value) throw new HttpError(400, 'pack object size mismatch');
      const sha = hashObject(type, inf.data);
      const obj = { type, data: inf.data };
      out.set(sha, obj);
      byOffset.set(start, obj);
    }
  }
  return out;
}

// ---------------------------------------------------------------- object graphs

function peelToCommit(sha: string): string | undefined {
  let cur = sha;
  for (let i = 0; i < 16; i += 1) {
    const obj = getObject(cur);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return cur;
    if (obj.type !== 'tag') return undefined;
    const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
    if (m === null) return undefined;
    cur = m[1];
  }
  return undefined;
}

function tagPeel(sha: string): string | undefined {
  const obj = getObject(sha);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return peelToCommit(sha);
}

/** Every object reachable from the given roots (commits or tags). Commit traversal stops
 * at stopCommits (a shallow client's boundaries: it holds those commits, not their history). */
function closure(roots: readonly string[], stopCommits: ReadonlySet<string> = new Set()): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = getObject(sha);
    if (obj === undefined) continue;
    seen.add(sha);
    if (obj.type === 'commit') {
      const info = parseCommit(sha);
      if (info !== undefined) {
        stack.push(info.tree);
        if (!stopCommits.has(sha)) for (const p of info.parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      const data = obj.data;
      let at = 0;
      while (at < data.length) {
        const nul = data.indexOf(0x00, at);
        const entrySha = data.subarray(nul + 1, nul + 21).toString('hex');
        at = nul + 21;
        stack.push(entrySha);
      }
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m !== null) stack.push(m[1]);
    }
  }
  return seen;
}

function treeClosure(treeSha: string, exclude: Set<string>, into: Set<string>): void {
  const stack = [treeSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (into.has(sha) || exclude.has(sha)) continue;
    const obj = getObject(sha);
    if (obj === undefined) continue;
    into.add(sha);
    if (obj.type === 'tree') {
      const data = obj.data;
      let at = 0;
      while (at < data.length) {
        const nul = data.indexOf(0x00, at);
        stack.push(data.subarray(nul + 1, nul + 21).toString('hex'));
        at = nul + 21;
      }
    }
  }
}

interface FetchPlan {
  packShas: string[];
  shallow: string[];
  unshallow: string[];
}

export function planFetch(wants: string[], haves: string[], clientShallow: string[], depth: number | null): FetchPlan {
  const clientSet = new Set(clientShallow);
  const haveSet = closure(haves, clientSet);
  const packSet = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  const rootCommits: string[] = [];
  for (const want of wants) {
    const obj = getObject(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!haveSet.has(want)) packSet.add(want);
      const commit = peelToCommit(want);
      if (commit !== undefined) rootCommits.push(commit);
    } else if (obj.type === 'commit') {
      rootCommits.push(want);
    }
  }

  if (depth !== null) {
    const included = new Set<string>();
    const seen = new Set<string>();
    const queue: Array<[string, number]> = rootCommits.map((c) => [c, 1]);
    while (queue.length > 0) {
      const [sha, d] = queue.shift() as [string, number];
      if (seen.has(sha)) continue;
      seen.add(sha);
      const info = parseCommit(sha);
      if (info === undefined) continue;
      included.add(sha);
      if (d < depth) {
        if (clientSet.has(sha)) unshallow.push(sha);
        for (const p of info.parents) queue.push([p, d + 1]);
      } else if (!haveSet.has(sha) && !clientSet.has(sha)) {
        shallow.push(sha);
      }
    }
    for (const sha of included) {
      if (haveSet.has(sha) || clientSet.has(sha)) continue;
      packSet.add(sha);
      const info = parseCommit(sha);
      if (info !== undefined) treeClosure(info.tree, haveSet, packSet);
    }
  } else {
    const seen = new Set<string>();
    const stack = [...rootCommits];
    while (stack.length > 0) {
      const sha = stack.pop() as string;
      if (seen.has(sha) || haveSet.has(sha) || clientSet.has(sha)) continue;
      seen.add(sha);
      const info = parseCommit(sha);
      if (info === undefined) continue;
      packSet.add(sha);
      treeClosure(info.tree, haveSet, packSet);
      for (const p of info.parents) stack.push(p);
    }
  }

  for (const sha of packSet) {
    if (haveSet.has(sha) || clientSet.has(sha)) packSet.delete(sha);
  }
  return { packShas: [...packSet], shallow, unshallow };
}

// ---------------------------------------------------------------- advertisements

function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const peeled = tagPeel(oid);
      if (peeled !== undefined && peeled !== oid) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

function advertiseV0(res: ServerResponse, repo: Repo, service: string): void {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-done include-tag symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = refLines(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (headTip !== undefined) {
      parts.push(pkt(`${headTip} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      parts.push(pkt(first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`));
      first = false;
      if (ref.peeled !== undefined) parts.push(pkt(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
  res.end(Buffer.concat(parts));
}

function advertiseV2(res: ServerResponse): void {
  const body = Buffer.concat([
    pkt('version 2\n'),
    pkt('ls-refs\n'),
    pkt('fetch=shallow\n'),
    pkt(`object-format=sha1\n`),
    pkt(`agent=${AGENT}\n`),
    FLUSH,
  ]);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
  res.end(body);
}

// ---------------------------------------------------------------- upload-pack

function handleLsRefs(repo: Repo, args: string[], res: ServerResponse): void {
  const prefixes: string[] = [];
  let symrefs = false;
  for (const arg of args) {
    if (arg === 'symrefs') symrefs = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined && keep('HEAD')) {
    parts.push(pkt(`${headTip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
  }
  for (const ref of refLines(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function sendFetchV2(res: ServerResponse, plan: FetchPlan, done: boolean): void {
  const parts: Buffer[] = [];
  if (done) {
    parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
    for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
    parts.push(FLUSH);
  }
  const pack = writePack(plan.packShas);
  parts.push(pkt('packfile\n'));
  for (const frame of sidebandFrames(pack, 1)) parts.push(frame);
  parts.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function sendFetchV0(res: ServerResponse, plan: FetchPlan): void {
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pkt(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pkt(`unshallow ${sha}\n`));
  parts.push(pkt('NAK\n'));
  const pack = writePack(plan.packShas);
  for (const frame of sidebandFrames(pack, 1)) parts.push(frame);
  parts.push(FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, repo: Repo, v2: boolean): Promise<void> {
  const body = await readBody(req);
  const { packets } = decodePackets(body);
  const lines = linesOf(packets);
  if (v2) {
    const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length) ?? '';
    const delimAt = packets.findIndex((p) => p.kind === 'delim');
    const args = linesOf(delimAt >= 0 ? packets.slice(delimAt + 1) : packets);
    if (command === 'ls-refs') {
      handleLsRefs(repo, args, res);
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const clientShallow: string[] = [];
      let depth: number | null = null;
      let done = false;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim()) || null;
        else if (arg === 'done') done = true;
      }
      const plan = planFetch(wants, haves, clientShallow, depth);
      sendFetchV2(res, plan, done);
      return;
    }
    throw new HttpError(400, `unknown v2 command ${command}`);
  }
  // v0: wants section (flush), then haves + done (flush)
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim()) || null;
  }
  void section;
  const plan = planFetch(wants, haves, clientShallow, depth);
  sendFetchV0(res, plan);
}

// ---------------------------------------------------------------- receive-pack

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = decodePackets(body);
  const commands: Array<{ old: string; new: string; ref: string }> = [];
  let caps = '';
  let first = true;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.data.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
    if (m === null) throw new HttpError(400, 'bad receive-pack command line');
    commands.push({ old: m[1], new: m[2], ref: m[3] });
  }

  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const parsed = readPack(rest);
      for (const [, obj] of parsed) putObject(obj.type, obj.data);
    } catch (err) {
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const reports: string[] = [];
  if (unpackDetail === 'ok') {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.new === ZERO) {
        if (current === undefined) {
          reports.push(`ng ${cmd.ref} ref not found`);
        } else {
          repo.refs.delete(cmd.ref);
          reports.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      if (getObject(cmd.new) === undefined) {
        reports.push(`ng ${cmd.ref} missing object`);
        continue;
      }
      if (cmd.old === ZERO) {
        if (current !== undefined) {
          reports.push(`ng ${cmd.ref} already exists`);
        } else {
          repo.refs.set(cmd.ref, cmd.new);
          reports.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      if (current !== cmd.old || !isAncestor(cmd.old, cmd.new)) {
        reports.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.new);
      reports.push(`ok ${cmd.ref}`);
    }
  }

  const wantsReport = caps.includes('report-status');
  const wantsSideband = caps.includes('side-band-64k');
  const parts: Buffer[] = [];
  if (wantsReport) {
    const reportParts: Buffer[] = [pkt(`unpack ${unpackDetail}\n`)];
    for (const line of reports) reportParts.push(pkt(`${line}\n`));
    reportParts.push(FLUSH);
    const report = Buffer.concat(reportParts);
    if (wantsSideband) {
      for (const frame of sidebandFrames(report, 1)) parts.push(frame);
      parts.push(FLUSH);
    } else {
      parts.push(report);
    }
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat(parts));
}

// ---------------------------------------------------------------- the router

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  sub: string,
  url: URL,
  method: string,
): Promise<void> {
  if (owner !== OWNER) throw new HttpError(404, 'Not Found');
  const repo = repos.get(repoName);
  if (repo === undefined) throw new HttpError(404, 'Not Found');
  const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');

  if (sub === '/info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      if (v2) advertiseV2(res);
      else advertiseV0(res, repo, 'git-upload-pack');
      return;
    }
    if (service === 'git-receive-pack') {
      advertiseV0(res, repo, 'git-receive-pack');
      return;
    }
    throw new HttpError(404, 'Not Found');
  }
  if (sub === '/git-upload-pack' && method === 'POST') {
    await handleUploadPack(req, res, repo, v2);
    return;
  }
  if (sub === '/git-receive-pack' && method === 'POST') {
    await handleReceivePack(req, res, repo);
    return;
  }
  throw new HttpError(404, 'Not Found');
}