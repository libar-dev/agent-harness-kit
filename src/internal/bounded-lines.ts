import { open } from 'node:fs/promises';

const READ_CHUNK_BYTES = 64 * 1024;

/** One line emitted by a bounded byte-oriented file scan. */
export type BoundedLine =
  | {
      readonly kind: 'line';
      readonly lineNumber: number;
      readonly value: string;
    }
  | {
      readonly kind: 'oversized';
      readonly lineNumber: number;
    };

/** Options for a bounded newline scan. */
export type ReadBoundedLinesOptions = {
  readonly maxLineBytes: number;
};

/**
 * Stream a file by newline without retaining more than `maxLineBytes`.
 *
 * Line and oversized entries are yielded only after a `0x0a` byte. An
 * unterminated EOF tail is deferred with no diagnostic. Once a line crosses
 * the ceiling its buffered chunks are released; the oversized diagnostic is
 * still emitted only when that line's newline arrives. Callers that continue
 * consume the remainder in discard mode without a duplicate diagnostic.
 *
 * @param path - File to stream.
 * @param options - Scan limits; `maxLineBytes` is the per-line retention ceiling.
 * @yields Newline-terminated lines, or bounded oversized diagnostics.
 */
export async function* readBoundedLines(
  path: string,
  options: ReadBoundedLinesOptions
): AsyncGenerator<BoundedLine> {
  const { maxLineBytes } = options;
  const file = await open(path, 'r');
  try {
    const readBuffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let readOffset = 0;
    let lineNumber = 1;
    let lineByteLength = 0;
    let lineChunks: Buffer[] = [];
    let oversized = false;

    for (;;) {
      const { bytesRead } = await file.read(
        readBuffer,
        0,
        readBuffer.byteLength,
        readOffset
      );
      if (bytesRead === 0) break;

      let chunkOffset = 0;
      while (chunkOffset < bytesRead) {
        const foundNewline = readBuffer.indexOf(0x0a, chunkOffset);
        const newlineIndex =
          foundNewline >= 0 && foundNewline < bytesRead
            ? foundNewline
            : bytesRead;
        const segment = readBuffer.subarray(chunkOffset, newlineIndex);
        const segmentLength = segment.byteLength;

        if (!oversized) {
          if (lineByteLength + segmentLength > maxLineBytes) {
            oversized = true;
            lineChunks = [];
          } else if (segmentLength > 0) {
            lineChunks.push(Buffer.from(segment));
          }
        }
        lineByteLength += segmentLength;

        if (newlineIndex === bytesRead) break;

        if (oversized) {
          yield { kind: 'oversized', lineNumber };
        } else {
          yield {
            kind: 'line',
            lineNumber,
            value: Buffer.concat(lineChunks, lineByteLength).toString('utf8'),
          };
        }
        lineNumber += 1;
        lineByteLength = 0;
        lineChunks = [];
        oversized = false;
        chunkOffset = newlineIndex + 1;
      }
      readOffset += bytesRead;
    }
  } finally {
    await file.close();
  }
}
