import { HUFF_FREQ } from './huff-data.js';

const HMAX = 256;
const NYT = HMAX;
const INTERNAL = HMAX + 1;

interface Head {
  node: HuffNode | null;
  nextFree: Head | null;
}

class HuffNode {
  symbol = 0;
  weight = 0;
  parent: HuffNode | null = null;
  left: HuffNode | null = null;
  right: HuffNode | null = null;
  next: HuffNode | null = null;
  prev: HuffNode | null = null;
  head: Head | null = null;
}

class HuffTree {
  root: HuffNode | null = null;
  lhead: HuffNode | null = null;
  loc: (HuffNode | null)[] = Array.from({ length: HMAX + 1 }, () => null);
  private freelist: Head | null = null;

  private freshHead(): Head {
    if (this.freelist) {
      const head = this.freelist;
      this.freelist = head.nextFree;
      head.nextFree = null;
      head.node = null;
      return head;
    }
    return { node: null, nextFree: null };
  }

  private freeHead(head: Head): void {
    head.node = null;
    head.nextFree = this.freelist;
    this.freelist = head;
  }

  private swap(a: HuffNode, b: HuffNode): void {
    const par1 = a.parent;
    const par2 = b.parent;
    if (par1) {
      if (par1.left === a) par1.left = b;
      else par1.right = b;
    } else {
      this.root = b;
    }
    if (par2) {
      if (par2.left === b) par2.left = a;
      else par2.right = a;
    } else {
      this.root = a;
    }
    a.parent = par2;
    b.parent = par1;
  }

  private swapList(a: HuffNode, b: HuffNode): void {
    const next = a.next;
    a.next = b.next;
    b.next = next;
    const prev = a.prev;
    a.prev = b.prev;
    b.prev = prev;
    if (a.next === a) a.next = b;
    if (b.next === b) b.next = a;
    if (a.next) a.next.prev = a;
    if (b.next) b.next.prev = b;
    if (a.prev) a.prev.next = a;
    if (b.prev) b.prev.next = b;
  }

  private increment(node: HuffNode | null): void {
    if (!node) return;
    if (node.next && node.next.weight === node.weight) {
      const headNode = node.head?.node ?? null;
      if (headNode && headNode !== node.parent) this.swap(headNode, node);
      if (headNode) this.swapList(headNode, node);
    }
    if (node.prev && node.prev.weight === node.weight) {
      if (node.head) node.head.node = node.prev;
    } else if (node.head) {
      node.head.node = null;
      this.freeHead(node.head);
    }
    node.weight++;
    if (node.next && node.next.weight === node.weight) {
      node.head = node.next.head;
    } else {
      node.head = this.freshHead();
      node.head.node = node;
    }
    if (node.parent) {
      this.increment(node.parent);
      if (node.prev === node.parent) {
        this.swapList(node, node.parent);
        if (node.head && node.head.node === node) node.head.node = node.parent;
      }
    }
  }

  addRef(symbol: number): void {
    const existing = this.loc[symbol];
    if (!existing) {
      const leaf = new HuffNode();
      const internal = new HuffNode();
      internal.symbol = INTERNAL;
      internal.weight = 1;
      internal.next = this.lhead?.next ?? null;
      if (this.lhead?.next) {
        this.lhead.next.prev = internal;
        if (this.lhead.next.weight === 1) {
          internal.head = this.lhead.next.head;
        } else {
          internal.head = this.freshHead();
          internal.head.node = internal;
        }
      } else {
        internal.head = this.freshHead();
        internal.head.node = internal;
      }
      if (this.lhead) {
        this.lhead.next = internal;
        internal.prev = this.lhead;
      }
      leaf.symbol = symbol;
      leaf.weight = 1;
      leaf.next = this.lhead?.next ?? null;
      if (this.lhead?.next) {
        this.lhead.next.prev = leaf;
        if (this.lhead.next.weight === 1) {
          leaf.head = this.lhead.next.head;
        } else {
          leaf.head = this.freshHead();
          leaf.head.node = internal;
        }
      }
      if (this.lhead) {
        this.lhead.next = leaf;
        leaf.prev = this.lhead;
      }
      leaf.left = null;
      leaf.right = null;
      if (this.lhead?.parent) {
        if (this.lhead.parent.left === this.lhead)
          this.lhead.parent.left = internal;
        else this.lhead.parent.right = internal;
      } else {
        this.root = internal;
      }
      internal.right = leaf;
      internal.left = this.lhead;
      internal.parent = this.lhead?.parent ?? null;
      if (this.lhead) this.lhead.parent = internal;
      leaf.parent = internal;
      this.loc[symbol] = leaf;
      this.increment(internal.parent);
      return;
    }
    this.increment(existing);
  }

  transmit(
    symbol: number,
    out: Uint8Array,
    bloc: { n: number },
    maxOut: number,
  ): boolean {
    const node = this.loc[symbol];
    if (!node) return false;
    const bits: number[] = [];
    let child: HuffNode | null = null;
    let cursor: HuffNode | null = node;
    while (cursor) {
      if (child) bits.push(cursor.right === child ? 1 : 0);
      child = cursor;
      cursor = cursor.parent;
    }
    for (let i = bits.length - 1; i >= 0; i--) {
      if (!putBit(bits[i] ?? 0, out, bloc, maxOut)) return false;
    }
    return true;
  }

  receive(
    input: Uint8Array,
    bloc: { n: number },
    inputBytes: number,
  ): number | null {
    let node = this.root;
    while (node && node.symbol === INTERNAL) {
      const bit = getBit(input, bloc, inputBytes);
      if (bit < 0) return null;
      node = bit ? node.right : node.left;
    }
    if (!node) return null;
    return node.symbol;
  }
}

function putBit(
  bit: number,
  out: Uint8Array,
  bloc: { n: number },
  maxOut: number,
): boolean {
  const index = bloc.n >> 3;
  if (index >= maxOut) return false;
  const shift = bloc.n & 7;
  if (shift === 0) out[index] = 0;
  out[index] = (out[index] ?? 0) | (bit << shift);
  bloc.n++;
  return true;
}

function getBit(
  input: Uint8Array,
  bloc: { n: number },
  inputBytes: number,
): number {
  if (bloc.n >> 3 >= inputBytes) return -1;
  const bit = (input[bloc.n >> 3] >> (bloc.n & 7)) & 1;
  bloc.n++;
  return bit;
}

function buildTree(): HuffTree {
  const tree = new HuffTree();
  const nyt = new HuffNode();
  nyt.symbol = NYT;
  nyt.weight = 0;
  tree.root = nyt;
  tree.lhead = nyt;
  tree.loc[NYT] = nyt;
  for (let symbol = 0; symbol < HMAX; symbol++) {
    const count = HUFF_FREQ[symbol] ?? 0;
    for (let n = 0; n < count; n++) tree.addRef(symbol);
  }
  return tree;
}

let shared: HuffTree | null = null;

function tree(): HuffTree {
  shared ??= buildTree();
  return shared;
}

export type HuffResult =
  { ok: true; data: Uint8Array } | { ok: false; reason: 'cap' | 'truncated' };

/** Compress. Fails instead of growing past `maxOut`. */
export function huffmanCompress(input: Uint8Array, maxOut: number): HuffResult {
  if (maxOut < 0) return { ok: false, reason: 'cap' };
  const out = new Uint8Array(Math.max(0, maxOut));
  const bloc = { n: 0 };
  const coder = tree();
  for (let i = 0; i < input.length; i++) {
    if (!coder.transmit(input[i] ?? 0, out, bloc, maxOut))
      return { ok: false, reason: 'cap' };
  }
  const bytes = (bloc.n + 7) >> 3;
  if (bytes > maxOut) return { ok: false, reason: 'cap' };
  return { ok: true, data: out.subarray(0, bytes) };
}

/**
 * Decompress. A code cut off before it finishes fails. Zero bits that only pad
 * the last byte after a finished symbol are the compressor's byte align, not a cut.
 */
export function huffmanDecompress(
  input: Uint8Array,
  maxOut: number,
): HuffResult {
  if (maxOut < 0) return { ok: false, reason: 'cap' };
  const out: number[] = [];
  const bloc = { n: 0 };
  const limit = input.length * 8;
  const coder = tree();
  while (bloc.n < limit) {
    const started = bloc.n;
    const symbol = coder.receive(input, bloc, input.length);
    if (symbol === null) {
      if (bloc.n !== started && !isZeroTailPad(input, started, bloc.n))
        return { ok: false, reason: 'truncated' };
      if (out.length === 0 && input.length > 0)
        return { ok: false, reason: 'truncated' };
      break;
    }
    if (out.length >= maxOut) return { ok: false, reason: 'cap' };
    out.push(symbol);
  }
  return { ok: true, data: Uint8Array.from(out) };
}

/** True when the unfinished code is only the zero fill in the final byte. */
function isZeroTailPad(
  input: Uint8Array,
  fromBit: number,
  toBit: number,
): boolean {
  if (input.length === 0 || fromBit < (input.length - 1) * 8) return false;
  for (let bit = fromBit; bit < toBit; bit++) {
    if (((input[bit >> 3] ?? 0) >> (bit & 7)) & 1) return false;
  }
  return true;
}
