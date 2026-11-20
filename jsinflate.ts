// A single-pass raw DEFLATE decoder that returns the decoded bytes and the exact
// number of input bytes consumed. Used to read pack objects without the overhead of
// repeated zlib.inflateSync calls (the push workload inflates many small objects).
// Implements RFC 1951: stored, fixed-Huffman and dynamic-Huffman blocks.

interface InflateResult {
  data: Buffer;
  consumed: number;
}

class BitReader {
  buf: Buffer;
  pos = 0; // byte position
  bit = 0; // bit position within current byte (0..7)
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  bits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i += 1) {
      const byte = this.buf[this.pos];
      value |= ((byte >> this.bit) & 1) << i;
      this.bit += 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos += 1;
      }
    }
    return value;
  }
  align(): void {
    if (this.bit !== 0) {
      this.bit = 0;
      this.pos += 1;
    }
  }
}

// Canonical Huffman decoding table: map (code length, code) -> symbol via a fast lookup.
class Huffman {
  counts: number[];
  symbols: number[];
  constructor(lengths: number[]) {
    const maxBits = lengths.reduce((m, x) => Math.max(m, x), 0);
    this.counts = new Array(maxBits + 1).fill(0);
    for (const l of lengths) if (l > 0) this.counts[l] += 1;
    this.counts[0] = 0;
    const offsets = new Array(maxBits + 2).fill(0);
    for (let i = 1; i <= maxBits; i += 1) offsets[i + 1] = offsets[i] + this.counts[i];
    this.symbols = new Array(lengths.length).fill(0);
    const next = offsets.slice();
    for (let sym = 0; sym < lengths.length; sym += 1) {
      const l = lengths[sym];
      if (l > 0) this.symbols[next[l]++] = sym;
    }
  }
  decode(br: BitReader): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < this.counts.length; len += 1) {
      code |= br.bits(1);
      const count = this.counts[len];
      if (code - first < count) return this.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('invalid Huffman code');
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function fixedLit(): Huffman {
  const lengths = new Array(288).fill(0);
  for (let i = 0; i < 144; i += 1) lengths[i] = 8;
  for (let i = 144; i < 256; i += 1) lengths[i] = 9;
  for (let i = 256; i < 280; i += 1) lengths[i] = 7;
  for (let i = 280; i < 288; i += 1) lengths[i] = 8;
  return new Huffman(lengths);
}
function fixedDist(): Huffman {
  return new Huffman(new Array(30).fill(5));
}
const FIXED_LIT = fixedLit();
const FIXED_DIST = fixedDist();

const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

export function jsInflate(buf: Buffer, start: number): InflateResult {
  const br = new BitReader(buf);
  br.pos = start;
  const out: number[] = [];
  for (;;) {
    const bfinal = br.bits(1);
    const btype = br.bits(2);
    if (btype === 0) {
      br.align();
      const len = buf[br.pos] | (buf[br.pos + 1] << 8);
      br.pos += 4;
      for (let i = 0; i < len; i += 1) out.push(buf[br.pos + i]);
      br.pos += len;
    } else {
      let lit: Huffman;
      let dist: Huffman;
      if (btype === 1) {
        lit = FIXED_LIT;
        dist = FIXED_DIST;
      } else if (btype === 2) {
        const hlit = br.bits(5) + 257;
        const hdist = br.bits(5) + 1;
        const hclen = br.bits(4) + 4;
        const clenLengths = new Array(19).fill(0);
        for (let i = 0; i < hclen; i += 1) clenLengths[CLEN_ORDER[i]] = br.bits(3);
        const clen = new Huffman(clenLengths);
        const lengths: number[] = [];
        while (lengths.length < hlit + hdist) {
          const sym = clen.decode(br);
          if (sym < 16) lengths.push(sym);
          else if (sym === 16) {
            const prev = lengths[lengths.length - 1];
            const rep = 3 + br.bits(2);
            for (let i = 0; i < rep; i += 1) lengths.push(prev);
          } else if (sym === 17) {
            const rep = 3 + br.bits(3);
            for (let i = 0; i < rep; i += 1) lengths.push(0);
          } else {
            const rep = 11 + br.bits(7);
            for (let i = 0; i < rep; i += 1) lengths.push(0);
          }
        }
        lit = new Huffman(lengths.slice(0, hlit));
        dist = new Huffman(lengths.slice(hlit, hlit + hdist));
      } else {
        throw new Error('invalid DEFLATE block type 3');
      }
      for (;;) {
        const sym = lit.decode(br);
        if (sym < 256) out.push(sym);
        else if (sym === 256) break;
        else {
          const li = sym - 257;
          const length = LENGTH_BASE[li] + br.bits(LENGTH_EXTRA[li]);
          const ds = dist.decode(br);
          const distance = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds]);
          const from = out.length - distance;
          for (let i = 0; i < length; i += 1) out.push(out[from + i]);
        }
      }
    }
    if (bfinal === 1) break;
  }
  br.align();
  return { data: Buffer.from(out), consumed: br.pos - start };
}