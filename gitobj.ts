// The git object model and wire codecs: SHA-1 object ids, tree/commit/tag parsing and
// building, packfile reading (plain objects and both delta forms) and writing, the
// pkt-line framing, reachability walks, and the three-way tree merge a squash needs.
// Everything is bytes-in/bytes-out: an object is correct when its SHA-1 recomputes.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
const PKT_MAX_PAYLOAD = PKT_LINE_MAX - 4;

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` plus the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- pkt-line

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a complete pkt-line stream; `allowTrailing` stops at raw (unframed) bytes. */
export function decodePkts(bytes: Buffer, allowTrailing = false): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      if (allowTrailing) break;
      throw new Error(`invalid pkt-line header ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > bytes.length) {
      if (allowTrailing) break;
      throw new Error('truncated pkt-line');
    }
    packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
    offset += length;
  }
  if (!allowTrailing && offset !== bytes.length) throw new Error('trailing bytes after pkt-line stream');
  return { packets, rest: bytes.subarray(offset) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree order: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export interface CommitFields {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
  timezone?: string;
}

export function buildCommit(fields: CommitFields): Buffer {
  const tz = fields.timezone ?? '+0000';
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} ${tz}`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} ${tz}`);
  lines.push('');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** The identity a REST-made commit carries (the token's user, at the deterministic clock). */
export function identityLine(name: string, email: string, timestamp: number): string {
  return `${name} <${email}> ${timestamp} +0000`;
}

/** Parse an author/committer line's name, email and unix seconds. */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (match === null) return { name: line, email: '', timestamp: 0 };
  return { name: match[1] as string, email: match[2] as string, timestamp: Number(match[3]) };
}

// ---------------------------------------------------------------- reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from the roots; gitlinks (160000) name commits we do not hold. */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` by following commit parents. */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** Peel a tag chain to the commit (or other object) it ultimately names. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- packfiles

/** Inflate one zlib stream at `offset`, returning its bytes and the offset past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  if (!result.engine.bytesWritten) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function readSizeVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack size varint too long');
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Apply a git delta instruction stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

/** Read a packfile into objects, resolving OFS_DELTA and REF_DELTA (thin bases via lookup). */
export function readPack(pack: Buffer, resolveBase?: ObjectLookup): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.subarray(trailerStart).toString('hex') !== expected) throw new Error('pack checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolved?: GitObject;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readSizeVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.distance;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('stray bytes before pack trailer');

  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): GitObject => {
    if (entry.resolved) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = byOid.get(wanted);
      const base = baseEntry !== undefined ? resolve(baseEntry) : resolveBase?.(wanted);
      if (base === undefined) throw new Error(`ref-delta base ${wanted} unavailable`);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = { type, data };
    byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return entry.resolved;
  };
  for (const entry of raw) {
    const object = resolve(entry);
    const oid = hashObject(object.type, object.data);
    if (!objects.has(oid)) objects.set(oid, object);
  }
  return objects;
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack of plain objects (no deltas): small, correct, fast to write. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Frame a pack into sideband band-1 pkt-lines (each packet at most PKT_LINE_MAX bytes). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const max = PKT_MAX_PAYLOAD - 1;
  for (let offset = 0; offset < pack.length; offset += max) {
    const slice = pack.subarray(offset, Math.min(offset + max, pack.length));
    chunks.push(pkt(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

// ---------------------------------------------------------------- tree paths and merging

export type FlatTree = Map<string, TreeEntry>;

/** Flatten a tree to path -> entry (files only; gitlinks kept as entries). */
export function flattenTree(treeOid: string, lookup: ObjectLookup, prefix = '', out: FlatTree = new Map()): FlatTree {
  const object = lookup(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(entry.oid, lookup, path, out);
    else out.set(path, entry);
  }
  return out;
}

/** A tree with `segments` set to the blob oid, every other entry kept; returns the root oid. */
export function treeWithPath(
  entries: readonly TreeEntry[],
  segments: readonly string[],
  blobOid: string,
  put: (type: GitObjectType, data: Buffer) => string,
  lookup: ObjectLookup,
): string {
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childEntries = existing === undefined ? [] : parseTree((lookup(existing.oid) as GitObject).data);
    kept.push({ mode: '40000', name: head, oid: treeWithPath(childEntries, rest, blobOid, put, lookup) });
  }
  return put('tree', buildTree(kept));
}

/** A tree with `segments` removed; returns the root oid. */
export function treeWithoutPath(
  entries: readonly TreeEntry[],
  segments: readonly string[],
  put: (type: GitObjectType, data: Buffer) => string,
  lookup: ObjectLookup,
): string {
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length > 0) {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    if (existing !== undefined) {
      const childEntries = parseTree((lookup(existing.oid) as GitObject).data);
      const childOid = treeWithoutPath(childEntries, rest, put, lookup);
      const child = lookup(childOid);
      // An emptied directory disappears, as git's own tree writes do.
      if (child !== undefined && parseTree(child.data).length > 0) {
        kept.push({ mode: '40000', name: head, oid: childOid });
      }
    }
  }
  return put('tree', buildTree(kept));
}

/** The entry a tree holds at a path, or null; directories answer their tree entry. */
export function treeEntryAt(treeOid: string, segments: readonly string[], lookup: ObjectLookup): TreeEntry | null {
  let currentOid = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = lookup(currentOid);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    currentOid = entry.oid;
  }
  return null;
}

/** Rebuild a tree object from a flat path map (the merge result). */
export function treeFromFlat(flat: FlatTree, put: (type: GitObjectType, data: Buffer) => string): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: [], dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = make();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, name: segments[segments.length - 1] as string, oid: entry.oid });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

export interface MergeResult {
  tree: string;
  conflict: boolean;
}

/** Three-way merge of flat trees: ours/theirs against the merge base. A path both sides
 * changed differently is a conflict; the merge stops at the first one. */
export function mergeFlatTrees(base: FlatTree, ours: FlatTree, theirs: FlatTree, put: (type: GitObjectType, data: Buffer) => string): MergeResult {
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const result: FlatTree = new Map();
  for (const path of [...paths].sort()) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t) {
      if (o !== undefined) result.set(path, (ours.get(path) ?? theirs.get(path)) as TreeEntry);
      continue;
    }
    if (o === b) {
      if (t !== undefined) result.set(path, theirs.get(path) as TreeEntry);
      continue;
    }
    if (t === b) {
      if (o !== undefined) result.set(path, ours.get(path) as TreeEntry);
      continue;
    }
    return { tree: '', conflict: true };
  }
  return { tree: treeFromFlat(result, put), conflict: false };
}

/** The merge base (best common ancestor) of two commits, or null when they share none. */
export function mergeBase(a: string, b: string, lookup: ObjectLookup): string | null {
  const ancestorsOf = (start: string): Map<string, number> => {
    const depths = new Map<string, number>();
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length > 0) {
      const [oid, depth] = queue.shift() as [string, number];
      if (depths.has(oid)) continue;
      depths.set(oid, depth);
      const object = lookup(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
    return depths;
  };
  const left = ancestorsOf(a);
  const right = ancestorsOf(b);
  let best: string | null = null;
  let bestSum = Number.POSITIVE_INFINITY;
  for (const [oid, depth] of left) {
    const other = right.get(oid);
    if (other === undefined) continue;
    if (depth + other < bestSum) {
      bestSum = depth + other;
      best = oid;
    }
  }
  return best;
}
