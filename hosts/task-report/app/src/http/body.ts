import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.ts';

const MAX_BYTES = 64 * 1024;

function mediaType(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  return header.split(';')[0]!.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function readBytes(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        req.off('data', onData);
        req.off('end', onEnd);
        req.resume();
        reject(new HttpError('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => resolve(Buffer.concat(chunks));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', reject);
  });
}

// Steps 4 to 6 of the order of evaluation.
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (mediaType(req.headers['content-type']) !== 'application/json') {
    throw new HttpError('unsupported_media_type');
  }
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > MAX_BYTES) {
    throw new HttpError('payload_too_large');
  }
  const bytes = await readBytes(req);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError('invalid_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError('invalid_json');
  }
  return value as Record<string, unknown>;
}
