/**
 * CoD2 bit cursor. A byte read/write does not realign `bit`: the in-progress
 * bit byte stays put and the byte op uses the cursor past it. That is how a
 * partial bit field and the following short/long share one message.
 */
export class BitMsg {
  readonly data: Uint8Array;
  cursize: number;
  readcount = 0;
  bit = 0;
  overflowed = false;

  constructor(data: Uint8Array, cursize?: number) {
    this.data = data;
    this.cursize = cursize ?? data.length;
  }

  static alloc(max: number): BitMsg {
    return new BitMsg(new Uint8Array(max), 0);
  }

  readBit(): number {
    const b = this.bit & 7;
    if (b === 0) {
      if (this.readcount >= this.cursize) {
        this.overflowed = true;
        return -1;
      }
      this.bit = this.readcount * 8;
      this.readcount++;
    }
    const byteIndex = this.bit >> 3;
    if (byteIndex >= this.cursize) {
      this.overflowed = true;
      return -1;
    }
    const bit = (this.data[byteIndex] >> b) & 1;
    this.bit++;
    return bit;
  }

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = this.readBit();
      if (bit < 0) return 0;
      value |= bit << i;
    }
    return value;
  }

  readByte(): number {
    if (this.readcount >= this.cursize) {
      this.overflowed = true;
      return -1;
    }
    return this.data[this.readcount++];
  }

  readShort(): number {
    if (this.readcount + 2 > this.cursize) {
      this.overflowed = true;
      return 0;
    }
    const value = this.data[this.readcount] | (this.data[this.readcount + 1] << 8);
    this.readcount += 2;
    return value;
  }

  readLong(): number {
    if (this.readcount + 4 > this.cursize) {
      this.overflowed = true;
      return 0;
    }
    const i = this.readcount;
    this.readcount += 4;
    return (this.data[i] | (this.data[i + 1] << 8) | (this.data[i + 2] << 16) | (this.data[i + 3] << 24)) | 0;
  }

  writeBit(value: number): void {
    if (this.cursize >= this.data.length) {
      this.overflowed = true;
      return;
    }
    const b = this.bit & 7;
    if (b === 0) {
      this.bit = this.cursize * 8;
      this.data[this.cursize] = 0;
      this.cursize++;
    }
    if (value & 1) this.data[this.bit >> 3] |= 1 << b;
    this.bit++;
  }

  writeBits(value: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.writeBit(value);
      value >>= 1;
    }
  }

  writeByte(value: number): void {
    if (this.cursize >= this.data.length) {
      this.overflowed = true;
      return;
    }
    this.data[this.cursize++] = value & 0xff;
  }

  writeShort(value: number): void {
    this.writeByte(value);
    this.writeByte(value >> 8);
  }

  writeLong(value: number): void {
    const v = value | 0;
    this.writeByte(v);
    this.writeByte(v >> 8);
    this.writeByte(v >> 16);
    this.writeByte(v >> 24);
  }

  bytes(): Uint8Array {
    return this.data.subarray(0, this.cursize);
  }
}
