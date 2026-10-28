/**
 * Streaming SHA-256. Each chunk is compressed and discarded.
 * Callers do not concatenate the file into a second buffer.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export interface IncrementalSha256 {
  update(chunk: Uint8Array): void;
  digest(): string;
}

export function createIncrementalSha256(): IncrementalSha256 {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const pending = new Uint8Array(64);
  let pendingLength = 0;
  let messageBytes = 0;
  let finished = false;

  const compress = (block: Uint8Array, offset: number) => {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      words[index] = (
        (block[start] << 24)
        | (block[start + 1] << 16)
        | (block[start + 2] << 8)
        | block[start + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotr(words[index - 15], 7) ^ rotr(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotr(words[index - 2], 17) ^ rotr(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + choose + K[index] + words[index]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  };

  const absorb = (chunk: Uint8Array, count: boolean) => {
    if (count) messageBytes += chunk.length;
    let offset = 0;
    if (pendingLength > 0) {
      const take = Math.min(64 - pendingLength, chunk.length);
      pending.set(chunk.subarray(0, take), pendingLength);
      pendingLength += take;
      offset = take;
      if (pendingLength === 64) {
        compress(pending, 0);
        pendingLength = 0;
      }
    }
    while (offset + 64 <= chunk.length) {
      compress(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.length) {
      pending.set(chunk.subarray(offset), 0);
      pendingLength = chunk.length - offset;
    }
  };

  return {
    update(chunk: Uint8Array) {
      if (finished) throw new Error('SHA-256 digest was already finalized.');
      if (chunk.length > 0) absorb(chunk, true);
    },
    digest() {
      if (finished) throw new Error('SHA-256 digest was already finalized.');
      finished = true;
      const bitLength = messageBytes * 8;
      const high = Math.floor(bitLength / 0x100000000);
      const low = bitLength >>> 0;
      const padLength = pendingLength < 56 ? 64 - pendingLength : 128 - pendingLength;
      const pad = new Uint8Array(padLength);
      pad[0] = 0x80;
      const view = new DataView(pad.buffer);
      view.setUint32(pad.length - 8, high);
      view.setUint32(pad.length - 4, low);
      absorb(pad, false);
      const words = [h0, h1, h2, h3, h4, h5, h6, h7];
      return words.map((word) => word.toString(16).padStart(8, '0')).join('');
    },
  };
}

export interface FileContentHash {
  digest: string;
  /** True when the file was hashed from its stream without a second full copy. */
  incremental: boolean;
  maxChunkBytes: number;
}

/**
 * Hash the exact Blob the analysis session captured.
 * A stream chunk is compressed and dropped. The fallback reads the blob once
 * only when the host cannot stream it.
 */
export async function hashBlobSha256(
  blob: Blob,
  observer?: { onChunk?: (byteLength: number) => void },
): Promise<FileContentHash> {
  const hasher = createIncrementalSha256();
  let maxChunkBytes = 0;
  const stream = typeof blob.stream === 'function' ? blob.stream() : null;
  if (stream) {
    const reader = stream.getReader();
    try {
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        if (!step.value || step.value.byteLength === 0) continue;
        maxChunkBytes = Math.max(maxChunkBytes, step.value.byteLength);
        observer?.onChunk?.(step.value.byteLength);
        hasher.update(step.value);
      }
    } finally {
      reader.releaseLock();
    }
    return { digest: hasher.digest(), incremental: true, maxChunkBytes };
  }

  const buffered = new Uint8Array(await blob.arrayBuffer());
  maxChunkBytes = buffered.byteLength;
  observer?.onChunk?.(buffered.byteLength);
  if (buffered.byteLength > 0) hasher.update(buffered);
  return { digest: hasher.digest(), incremental: false, maxChunkBytes };
}
