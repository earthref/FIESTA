// A small animated-GIF encoder for the global field movie: one global
// 256-colour palette (the map's colour table plus an RGB cube and greys for
// text, coastlines and contours), nearest-colour quantisation through a
// 15-bit lookup, LZW-compressed frames that loop forever.

type RGB = [number, number, number];

class Bytes {
  private chunks: Uint8Array[] = [];
  private buffer = new Uint8Array(1 << 16);
  private length = 0;
  byte(value: number) {
    if (this.length === this.buffer.length) this.flush();
    this.buffer[this.length++] = value & 0xff;
  }
  word(value: number) {
    this.byte(value & 0xff);
    this.byte((value >> 8) & 0xff);
  }
  bytes(values: ArrayLike<number>) {
    for (let i = 0; i < values.length; i++) this.byte(values[i]);
  }
  private flush() {
    this.chunks.push(this.buffer.slice(0, this.length));
    this.length = 0;
  }
  blob(type: string): Blob {
    this.flush();
    return new Blob(this.chunks as BlobPart[], { type });
  }
}

export class GifEncoder {
  private out = new Bytes();
  private palette: RGB[];
  private lookup = new Uint8Array(1 << 15);
  private table = new Int16Array(1 << 20);
  private frames = 0;

  constructor(
    private width: number,
    private height: number,
    colors: RGB[],
    private delayMs: number,
  ) {
    const palette: RGB[] = [];
    for (let i = 0; i < 128; i++) palette.push(colors[Math.round((i / 127) * (colors.length - 1))]);
    for (const r of [0, 64, 128, 192, 255])
      for (const g of [0, 64, 128, 192, 255])
        for (const b of [0, 64, 128, 192, 255]) palette.push([r, g, b]);
    for (const v of [32, 224, 240]) palette.push([v, v, v]);
    this.palette = palette.slice(0, 256);
    while (this.palette.length < 256) this.palette.push([0, 0, 0]);
    for (let key = 0; key < 1 << 15; key++) {
      const r = ((key >> 10) & 31) * 8 + 4;
      const g = ((key >> 5) & 31) * 8 + 4;
      const b = (key & 31) * 8 + 4;
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 256; i++) {
        const [pr, pg, pb] = this.palette[i];
        const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        if (d < distance) {
          distance = d;
          best = i;
        }
      }
      this.lookup[key] = best;
    }
    const o = this.out;
    o.bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
    o.word(width);
    o.word(height);
    o.byte(0xf7); // global colour table, 8-bit, 256 entries
    o.byte(0);
    o.byte(0);
    for (const [r, g, b] of this.palette) o.bytes([r, g, b]);
    // NETSCAPE2.0: loop forever.
    o.bytes([0x21, 0xff, 0x0b]);
    o.bytes(Array.from("NETSCAPE2.0", (c) => c.charCodeAt(0)));
    o.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  }

  add(context: CanvasRenderingContext2D) {
    const { data } = context.getImageData(0, 0, this.width, this.height);
    const indices = new Uint8Array(this.width * this.height);
    for (let i = 0, p = 0; i < indices.length; i++, p += 4) {
      indices[i] =
        this.lookup[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)];
    }
    const o = this.out;
    o.bytes([0x21, 0xf9, 0x04, 0x04]);
    o.word(Math.max(2, Math.round(this.delayMs / 10)));
    o.bytes([0x00, 0x00]);
    o.byte(0x2c);
    o.word(0);
    o.word(0);
    o.word(this.width);
    o.word(this.height);
    o.byte(0);
    this.lzw(indices);
    this.frames++;
  }

  /** GIF LZW (minimum code size 8), as omggif writes it. */
  private lzw(indices: Uint8Array) {
    const o = this.out;
    const minCode = 8;
    const clear = 1 << minCode;
    const eoi = clear + 1;
    o.byte(minCode);
    const block: number[] = [];
    let cur = 0;
    let shift = 0;
    let size = minCode + 1;
    const flushBlock = () => {
      if (!block.length) return;
      o.byte(block.length);
      o.bytes(block);
      block.length = 0;
    };
    const emit = (code: number) => {
      cur |= code << shift;
      shift += size;
      while (shift >= 8) {
        block.push(cur & 0xff);
        cur >>>= 8;
        shift -= 8;
        if (block.length === 255) flushBlock();
      }
    };
    const table = this.table;
    table.fill(-1);
    emit(clear);
    let next = eoi + 1;
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = table[key];
      if (found >= 0) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next === 4096) {
        emit(clear);
        next = eoi + 1;
        size = minCode + 1;
        table.fill(-1);
      } else {
        if (next >= 1 << size) size++;
        table[key] = next++;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (shift > 0) block.push(cur & 0xff);
    flushBlock();
    o.byte(0);
  }

  finish(): Blob {
    this.out.byte(0x3b);
    return this.out.blob("image/gif");
  }

  get count(): number {
    return this.frames;
  }
}
