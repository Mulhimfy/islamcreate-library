// Growable byte writer and reader for the index's varint formats.
// A varint is unsigned LEB128: seven bits a byte, low bits first.

export class Writer {
  constructor(size = 1 << 16) {
    this.buf = Buffer.allocUnsafe(size);
    this.len = 0;
  }

  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  varint(n) {
    this.ensure(10);
    while (n >= 0x80) {
      this.buf[this.len++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.len++] = n;
  }

  bytes(b) {
    this.ensure(b.length);
    if (typeof b === 'string') this.len += this.buf.write(b, this.len, 'utf8');
    else {
      this.buf.set(b, this.len);
      this.len += b.length;
    }
  }

  /** A UTF-8 string with its byte length in front. */
  str(s) {
    const n = Buffer.byteLength(s);
    this.varint(n);
    this.ensure(n);
    this.len += this.buf.write(s, this.len, 'utf8');
  }

  get view() {
    return this.buf.subarray(0, this.len);
  }

  reset() {
    this.len = 0;
  }
}

export class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.buf.length;
  }

  varint() {
    let n = 0;
    let mul = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      n += (b & 0x7f) * mul;
      if (b < 0x80) return n;
      mul *= 128;
    }
  }

  str() {
    const n = this.varint();
    const s = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}

/** Ascending integers as varint gaps (the first gap is from zero). */
export function encodeGaps(list, w = new Writer(list.length * 2 + 16)) {
  let prev = 0;
  for (let i = 0; i < list.length; i++) {
    w.varint(list[i] - prev);
    prev = list[i];
  }
  return w;
}

/** Byte length encodeGaps would produce, without writing. */
export function gapsSize(list) {
  let prev = 0;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    let g = list[i] - prev;
    prev = list[i];
    do {
      n++;
      g = Math.floor(g / 128);
    } while (g > 0);
  }
  return n;
}
