/**
 * Cursor Client Policy
 *
 * Single source of truth for Cursor request identity headers and checksum generation.
 */

import * as crypto from 'crypto';
import * as os from 'os';
import type { CursorApiCredentials } from './cursor-protobuf-schema';

export const CURSOR_CLIENT_VERSION = process.env.CCS_CURSOR_CLIENT_VERSION?.trim() || '3.9.8';
export const CURSOR_USER_AGENT = 'connect-es/1.6.1';

const UUID_DNS_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd42911', 'hex');

function getClientOs(): string {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function getClientArch(): string {
  if (process.arch === 'arm64') return 'arm64';
  return 'x64';
}

function generateSessionId(authToken: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(UUID_DNS_NAMESPACE);
  hash.update(authToken);
  const bytes = hash.digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function normalizeCursorAccessToken(accessToken: string): string {
  const delimIdx = accessToken.indexOf('::');
  return delimIdx !== -1 ? accessToken.slice(delimIdx + 2) : accessToken;
}

/**
 * Generate checksum using Jyh cipher (time-based XOR with rolling key seed=165)
 */
export function generateCursorChecksum(machineId: string, nowMs: number = Date.now()): string {
  if (!machineId) {
    throw new Error('Machine ID is required for Cursor API');
  }

  // Convert milliseconds to coarse ~1000-second units required by Cursor's checksum routine.
  const timestamp = Math.floor(nowMs / 1000000);
  // JS bitwise shifts wrap modulo 32, so >>40 and >>32 give wrong results.
  // Use Math.trunc division for upper bytes that exceed 32-bit range.
  const byteArray = new Uint8Array([
    Math.trunc(timestamp / 2 ** 40) & 0xff,
    Math.trunc(timestamp / 2 ** 32) & 0xff,
    (timestamp >>> 24) & 0xff,
    (timestamp >>> 16) & 0xff,
    (timestamp >>> 8) & 0xff,
    timestamp & 0xff,
  ]);

  let t = 165;
  for (let i = 0; i < byteArray.length; i++) {
    byteArray[i] = ((byteArray[i] ^ t) + (i % 256)) & 0xff;
    t = byteArray[i];
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let encoded = '';

  for (let i = 0; i < byteArray.length; i += 3) {
    const a = byteArray[i];
    const b = i + 1 < byteArray.length ? byteArray[i + 1] : 0;
    const c = i + 2 < byteArray.length ? byteArray[i + 2] : 0;

    encoded += alphabet[a >> 2];
    encoded += alphabet[((a & 3) << 4) | (b >> 4)];

    if (i + 1 < byteArray.length) {
      encoded += alphabet[((b & 15) << 2) | (c >> 6)];
    }
    if (i + 2 < byteArray.length) {
      encoded += alphabet[c & 63];
    }
  }

  return `${encoded}${machineId}`;
}

function buildCursorBaseHeaders(credentials: CursorApiCredentials): Record<string, string> {
  const cleanToken = normalizeCursorAccessToken(credentials.accessToken);

  if (!cleanToken) {
    throw new Error('Access token is empty after parsing');
  }

  if (!credentials.machineId) {
    throw new Error('Machine ID is required for Cursor API');
  }

  const ghostMode = credentials.ghostMode !== false;
  const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');

  return {
    authorization: `Bearer ${cleanToken}`,
    'x-amzn-trace-id': `Root=${crypto.randomUUID()}`,
    'x-client-key': tokenHash,
    'x-cursor-checksum': generateCursorChecksum(credentials.machineId),
    'x-cursor-client-version': CURSOR_CLIENT_VERSION,
    'x-cursor-client-type': 'ide',
    'x-cursor-client-os': getClientOs(),
    'x-cursor-client-arch': getClientArch(),
    'x-cursor-client-os-version': os.release() || 'unknown',
    'x-cursor-client-device-type': 'desktop',
    'x-cursor-config-version': crypto.randomUUID(),
    'x-cursor-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'x-ghost-mode': ghostMode ? 'true' : 'false',
    'x-new-onboarding-completed': 'false',
    'x-request-id': crypto.randomUUID(),
    'x-session-id': generateSessionId(cleanToken),
  };
}

export function buildCursorConnectHeaders(
  credentials: CursorApiCredentials
): Record<string, string> {
  return {
    ...buildCursorBaseHeaders(credentials),
    'connect-accept-encoding': 'gzip',
    'connect-protocol-version': '1',
    'content-type': 'application/connect+proto',
    'user-agent': CURSOR_USER_AGENT,
  };
}

export function buildCursorModelsHeaders(
  credentials: CursorApiCredentials
): Record<string, string> {
  return {
    ...buildCursorBaseHeaders(credentials),
    accept: 'application/json',
    'user-agent': CURSOR_USER_AGENT,
  };
}
