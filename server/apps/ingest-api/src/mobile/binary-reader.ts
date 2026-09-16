/**
 * Low-level binary reader for the mobile SDK wire protocol.
 *
 * Encoding (matches the SDK encoder exactly):
 *   - uint   → LEB128 varint, low 7 bits per byte, MSB = continuation
 *   - int    → zigzag, then varint  (n<<1) ^ (n>>63)
 *   - string → varint(byteLength) followed by UTF-8 bytes
 *   - bool   → single byte (1 = true)
 *
 * A batch is a flat concatenation of messages; each message is
 *   [varint type][varint timestamp][varint length][fields…]
 * read sequentially until the buffer is exhausted.
 */
export class BinaryReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  get pointer(): number {
    return this.offset;
  }

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  /** LEB128 unsigned varint. */
  readUint(): bigint {
    let x = 0n;
    let s = 0n;
    let i = 0;
    for (;;) {
      if (this.offset >= this.buf.length) {
        throw new Error("readUint: unexpected end of buffer");
      }
      const b = this.buf[this.offset++];
      if (b < 0x80) {
        if (i > 9 || (i === 9 && b > 1)) {
          throw new Error("readUint: varint overflows uint64");
        }
        return x | (BigInt(b) << s);
      }
      x |= BigInt(b & 0x7f) << s;
      s += 7n;
      i += 1;
    }
  }

  /** Convenience: varint as a JS number (safe for our value ranges). */
  readUintNum(): number {
    return Number(this.readUint());
  }

  /** Zigzag-decoded signed varint. */
  readInt(): bigint {
    const ux = this.readUint();
    let x = ux >> 1n;
    if (ux & 1n) x = ~x;
    return x;
  }

  /** varint(length) + UTF-8 bytes. */
  readString(): string {
    const len = Number(this.readUint());
    if (this.offset + len > this.buf.length) {
      throw new Error("readString: length exceeds buffer");
    }
    const s = this.buf.toString("utf8", this.offset, this.offset + len);
    this.offset += len;
    return s;
  }

  /** Single-byte boolean. */
  readBoolean(): boolean {
    if (this.offset >= this.buf.length) {
      throw new Error("readBoolean: unexpected end of buffer");
    }
    return this.buf[this.offset++] === 1;
  }
}
