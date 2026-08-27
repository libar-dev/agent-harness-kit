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

/**
 * Stream a file by newline without retaining more than `maxLineBytes`.
 *
 * Once a line crosses the ceiling its buffered chunks are released and a
 * diagnostic is yielded immediately. Callers that continue consume the
 * remainder in discard mode without receiving a duplicate diagnostic.
 *
 * @param path - File to stream.
 * @param maxLineBytes - Maximum bytes retained for one line.
 * @yields Complete or trailing lines, or bounded oversized diagnostics.
 */
export async function* readBoundedLines(
  path: string,
  maxLineBytes: number
): AsyncGenerator<BoundedLine> {
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
            yield { kind: 'oversized', lineNumber };
          } else if (segmentLength > 0) {
            lineChunks.push(Buffer.from(segment));
          }
        }
        lineByteLength += segmentLength;

        if (newlineIndex === bytesRead) break;

        if (!oversized) {
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

    if (lineByteLength > 0 && !oversized) {
      yield {
        kind: 'line',
        lineNumber,
        value: Buffer.concat(lineChunks, lineByteLength).toString('utf8'),
      };
    }
  } finally {
    await file.close();
  }
}
