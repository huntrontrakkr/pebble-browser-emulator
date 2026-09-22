import { crc32 } from './integrity.ts';

/**
 * Turns the watch's debug console bytes into readable log lines.
 *
 * PebbleOS 4.x does not print text on its debug UART. It speaks PULSEv2: each
 * frame is delimited by 0x55 and COBS-encoded, with any 0x55 in the encoding
 * written as 0x00, and ends in a little-endian CRC-32. Log records travel on the
 * push transport (0x5021) as application 3; link control (0xC021) carries no
 * text. Printing the raw bytes put flags, COBS codes and timestamps in the
 * session log as mojibake around each message.
 *
 * Older firmware and the diagnostic board print plain text, so text passes
 * through unchanged. A candidate that fails its CRC is text, and until a frame
 * has checked out, so is one that reaches a newline without opening with a
 * PULSE protocol number. That keeps an ASCII 'U' in plain output from
 * swallowing the line, while COBS length bytes that happen to be 0x0A do not
 * break a real frame.
 */
const FLAG = 0x55;
const LINK_CONTROL = 0xc021;
const PUSH = 0x5021;
const LOGGING = 3;
/** Bytes a candidate frame may hold before it is given up on as text. */
const MAX_FRAME = 2048;

export class PulseLogDecoder {
  private frame: number[] = [];
  private inFrame = false;
  private confirmed = false;
  private text = new TextDecoder();

  reset(): void {
    this.frame = [];
    this.inFrame = false;
    this.confirmed = false;
    this.text = new TextDecoder();
  }

  /** Feeds console bytes and returns the log lines they complete. */
  push(bytes: Uint8Array): string[] {
    const lines: string[] = [];
    let plain: number[] = [];
    const flushPlain = () => {
      if (!plain.length) return;
      const chunk = this.text.decode(Uint8Array.from(plain), { stream: true });
      if (chunk.trim()) lines.push(chunk.replace(/\s+$/, ''));
      plain = [];
    };
    for (const byte of bytes) {
      if (!this.inFrame) {
        if (byte === FLAG) {
          this.inFrame = true;
          this.frame = [];
        } else plain.push(byte);
        continue;
      }
      if (byte === FLAG) {
        // Back-to-back flags close one frame and open the next.
        if (!this.frame.length) continue;
        const decoded = decodeFrame(this.frame);
        if (decoded) {
          this.confirmed = true;
          flushPlain();
          if (decoded.line !== undefined) lines.push(decoded.line);
          this.frame = [];
          continue;
        }
        // Not a frame after all: the opening 'U' and what followed were text.
        // This flag may still open a real frame, so it starts the next one.
        plain.push(FLAG, ...this.frame);
        this.frame = [];
        continue;
      }
      this.frame.push(byte);
      if (
        (!this.confirmed && byte === 0x0a && !opensKnownFrame(this.frame)) ||
        this.frame.length > MAX_FRAME
      ) {
        plain.push(FLAG, ...this.frame);
        this.frame = [];
        this.inFrame = false;
      }
    }
    flushPlain();
    return lines;
  }
}

/** Whether a candidate starts with a protocol this console is known to send. */
function opensKnownFrame(body: number[]): boolean {
  const start = unstuff(body.slice(0, 3), true);
  if (!start || start.length < 2) return false;
  const protocol = (start[0] << 8) | start[1];
  return protocol === LINK_CONTROL || protocol === PUSH;
}

/** COBS decode; `partial` accepts a body cut short, for peeking at its start. */
function unstuff(body: number[], partial = false): Uint8Array | null {
  const out: number[] = [];
  let i = 0;
  while (i < body.length) {
    // The encoder writes 0x55 as 0x00 so the flag never appears inside.
    const code = body[i] === 0 ? FLAG : body[i];
    i++;
    for (let j = 1; j < code; j++) {
      if (i >= body.length) return partial ? Uint8Array.from(out) : null;
      out.push(body[i] === 0 ? FLAG : body[i]);
      i++;
    }
    if (code < 0xff && i < body.length) out.push(0);
  }
  return Uint8Array.from(out);
}

/** A checked frame: `line` is absent for frames that carry no log text. */
function decodeFrame(body: number[]): { line?: string } | null {
  const frame = unstuff(body);
  if (!frame || frame.length < 6) return null;
  const payload = frame.subarray(0, frame.length - 4);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (crc32(payload) !== view.getUint32(frame.length - 4, true)) return null;
  const protocol = view.getUint16(0);
  if (protocol === LINK_CONTROL) return {};
  if (protocol === PUSH && payload.length >= 6 && view.getUint16(2) === LOGGING) {
    const record = logRecord(payload.subarray(6));
    if (record) return { line: record };
  }
  return { line: `PULSE 0x${protocol.toString(16).padStart(4, '0')}, ${payload.length} bytes` };
}

/** PebbleOS text log record: type, 16-byte file, level, task, u64 ms, u16 line, message. */
function logRecord(record: Uint8Array): string | null {
  if (record.length < 29 || record[0] !== 1) return null;
  const ascii = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const file = ascii(record.subarray(1, 17)).replace(/\0[\s\S]*$/, '');
  const level = String.fromCharCode(record[17]);
  const line = new DataView(record.buffer, record.byteOffset + 27, 2).getUint16(0, true);
  const message = ascii(record.subarray(29))
    .replace(/\0[\s\S]*$/, '')
    .replace(/\s+$/, '');
  return `${level} ${file}:${line} ${message}`;
}
