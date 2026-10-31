import net from 'node:net';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

export type ScanOutcome =
  | { status: 'clean'; engine: string }
  | { status: 'infected'; detail: string; engine: string }
  | { status: 'oversized'; detail: string }
  | { status: 'timeout'; detail: string }
  | { status: 'unavailable'; detail: string }
  | { status: 'error'; detail: string };

export interface Scanner {
  scanFile(filePath: string, sizeBytes: number): Promise<ScanOutcome>;
  ping(): Promise<{ ok: boolean; version?: string; error?: string }>;
}

/**
 * ClamAV clamd client using the INSTREAM protocol. Streams the file in bounded chunks; the daemon
 * applies its own StreamMaxLength/MaxFileSize/MaxScanSize/MaxRecursion limits. Any reply other than
 * "stream: OK" is NOT treated as clean.
 */
export class ClamdScanner implements Scanner {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs: number,
    private readonly maxStreamBytes: number,
  ) {}

  async ping() {
    try {
      const v = await this.command('zVERSION\0');
      return { ok: /ClamAV/i.test(v), version: v.trim() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private command(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port });
      let buf = '';
      sock.setTimeout(10_000, () => {
        sock.destroy(new Error('clamd timeout'));
      });
      sock.on('connect', () => sock.write(cmd));
      sock.on('data', (d) => (buf += d.toString()));
      sock.on('error', reject);
      sock.on('close', () => resolve(buf.replace(/\0$/, '')));
    });
  }

  async scanFile(filePath: string, sizeBytes: number): Promise<ScanOutcome> {
    if (sizeBytes > this.maxStreamBytes) {
      return { status: 'oversized', detail: `file is ${sizeBytes} bytes; scanner limit is ${this.maxStreamBytes} bytes` };
    }
    return new Promise<ScanOutcome>((resolve) => {
      const sock = net.connect({ host: this.host, port: this.port });
      let reply = '';
      let settled = false;
      const done = (o: ScanOutcome) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        resolve(o);
      };
      const timer = setTimeout(() => done({ status: 'timeout', detail: `scan exceeded ${this.timeoutMs} ms` }), this.timeoutMs);
      sock.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'EHOSTUNREACH') {
          done({ status: 'unavailable', detail: `clamd unreachable (${e.code})` });
        } else if (e.code === 'EPIPE' || e.code === 'ECONNRESET') {
          // clamd closes the connection when a limit is exceeded; the reply (if any) is handled on close
          if (!reply) done({ status: 'error', detail: `connection closed by scanner (${e.code})` });
        } else {
          done({ status: 'error', detail: e.message });
        }
      });
      sock.on('data', (d) => {
        reply += d.toString();
      });
      sock.on('close', () => {
        clearTimeout(timer);
        const text = reply.replace(/\0/g, '').trim();
        if (!text) return done({ status: 'error', detail: 'empty reply from scanner' });
        if (/\bOK$/.test(text) && !/FOUND|ERROR/.test(text)) return done({ status: 'clean', engine: 'clamd' });
        if (/FOUND$/.test(text)) return done({ status: 'infected', detail: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''), engine: 'clamd' });
        if (/size limit exceeded/i.test(text)) return done({ status: 'oversized', detail: text });
        return done({ status: 'error', detail: text.slice(0, 200) });
      });
      sock.on('connect', async () => {
        sock.write('zINSTREAM\0');
        const CHUNK = 1024 * 1024;
        const framer = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            const len = Buffer.alloc(4);
            len.writeUInt32BE(chunk.length, 0);
            cb(null, Buffer.concat([len, chunk]));
          },
          flush(cb) {
            cb(null, Buffer.from([0, 0, 0, 0]));
          },
        });
        try {
          await pipeline(fs.createReadStream(filePath, { highWaterMark: CHUNK }), framer, sock, { end: false });
        } catch (e) {
          // EPIPE after clamd replied is normal for limit violations; the close handler decides.
          if (!reply) done({ status: 'error', detail: e instanceof Error ? e.message : String(e) });
        }
      });
    });
  }
}

/** Test/dev double that behaves per instructions; never used in production builds (guarded by config). */
export class FakeScanner implements Scanner {
  mode: ScanOutcome = { status: 'clean', engine: 'fake' };
  async ping() {
    return { ok: true, version: 'fake' };
  }
  async scanFile(): Promise<ScanOutcome> {
    return this.mode;
  }
}
