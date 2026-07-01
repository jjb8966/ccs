/**
 * Cursor IDE Authentication Handler
 *
 * Handles token import and authentication for Cursor IDE integration.
 * Supports auto-detection from Cursor's SQLite database.
 *
 * Token Location:
 * - Linux: ~/.config/Cursor/User/globalStorage/state.vscdb
 * - macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 * - Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb
 *
 * Database Keys:
 * - cursorAuth/accessToken: Access token
 * - storage.serviceMachineId: Machine ID for checksum
 */

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CursorCredentials, CursorAuthStatus, AutoDetectResult } from './types';
import { getCcsDir } from '../config/config-loader-facade';

const ACCESS_TOKEN_KEYS = ['cursorAuth/accessToken', 'cursorAuth/token'] as const;
const MACHINE_ID_KEYS = [
  'storage.serviceMachineId',
  'storage.machineId',
  'telemetry.machineId',
] as const;

/**
 * Resolve home directory from environment first for deterministic testability,
 * then fall back to os.homedir() when env vars are unavailable.
 */
function resolveHomeDir(): string {
  if (process.platform === 'win32') {
    return process.env.USERPROFILE || process.env.HOME || os.homedir();
  }

  return process.env.HOME || os.homedir();
}

/**
 * Get platform-specific path to Cursor's state.vscdb
 */
export function getTokenStorageCandidates(): string[] {
  const platform = process.platform;
  const home = resolveHomeDir();

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');

    return [
      path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      path.join(appData, 'Cursor - Insiders', 'User', 'globalStorage', 'state.vscdb'),
      path.join(localAppData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      path.join(localAppData, 'Programs', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    ];
  }

  if (platform === 'darwin') {
    return [
      path.join(
        home,
        'Library',
        'Application Support',
        'Cursor',
        'User',
        'globalStorage',
        'state.vscdb'
      ),
      path.join(
        home,
        'Library',
        'Application Support',
        'Cursor - Insiders',
        'User',
        'globalStorage',
        'state.vscdb'
      ),
    ];
  }

  return [
    path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    path.join(home, '.config', 'cursor', 'User', 'globalStorage', 'state.vscdb'),
  ];
}

export function getTokenStoragePath(): string {
  return getTokenStorageCandidates()[0];
}

function normalizeStateValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : trimmed;
  } catch {
    return trimmed;
  }
}

function getSqliteBinary(): string {
  return process.env.CCS_CURSOR_SQLITE_BIN || 'sqlite3';
}

/**
 * Query Cursor's SQLite database using sqlite3 CLI
 */
function queryStateDb(
  dbPath: string,
  key: string
): { value: string | null; sqliteAvailable: boolean; queryFailed: boolean } {
  try {
    // Escape single quotes to prevent SQL injection
    const sanitizedKey = key.replace(/'/g, "''");
    const result = execFileSync(
      getSqliteBinary(),
      [dbPath, `SELECT value FROM itemTable WHERE key='${sanitizedKey}'`],
      { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }
    );

    return {
      value: normalizeStateValue(result) || null,
      sqliteAvailable: true,
      queryFailed: false,
    };
  } catch (err) {
    // Check if sqlite3 is not installed
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { value: null, sqliteAvailable: false, queryFailed: false };
    }
    return { value: null, sqliteAvailable: true, queryFailed: true };
  }
}

function queryStateDbKeys(
  dbPath: string,
  keys: readonly string[]
): { value: string | null; sqliteAvailable: boolean; queryFailed: boolean } {
  for (const key of keys) {
    const result = queryStateDb(dbPath, key);
    if (!result.sqliteAvailable || result.queryFailed) return result;
    if (result.value) return result;
  }

  return { value: null, sqliteAvailable: true, queryFailed: false };
}

/**
 * Auto-detect tokens from Cursor's SQLite database
 */
export function autoDetectTokens(): AutoDetectResult {
  const checkedPaths = getTokenStorageCandidates();
  const existingPaths = checkedPaths.filter((candidate) => fs.existsSync(candidate));

  if (existingPaths.length === 0) {
    return {
      found: false,
      checkedPaths,
      reason: 'db_not_found',
      error: `Cursor state database not found. Checked:\n${checkedPaths.join('\n')}`,
    };
  }

  let sawSqliteUnavailable = false;
  let sawQueryFailure = false;
  let sawTokenMissing = false;
  let sawMachineIdMissing = false;
  let sawInvalidCredentials = false;
  let firstQueryFailurePath: string | undefined;
  let firstInvalidCredentialsPath: string | undefined;

  for (const dbPath of existingPaths) {
    const accessTokenResult = queryStateDbKeys(dbPath, ACCESS_TOKEN_KEYS);
    if (!accessTokenResult.sqliteAvailable) {
      sawSqliteUnavailable = true;
      continue;
    }
    if (accessTokenResult.queryFailed) {
      sawQueryFailure = true;
      firstQueryFailurePath ??= dbPath;
      continue;
    }

    if (!accessTokenResult.value) {
      sawTokenMissing = true;
      continue;
    }

    const machineIdResult = queryStateDbKeys(dbPath, MACHINE_ID_KEYS);
    if (!machineIdResult.sqliteAvailable) {
      sawSqliteUnavailable = true;
      continue;
    }
    if (machineIdResult.queryFailed) {
      sawQueryFailure = true;
      firstQueryFailurePath ??= dbPath;
      continue;
    }

    if (!machineIdResult.value) {
      sawMachineIdMissing = true;
      continue;
    }

    if (!validateToken(accessTokenResult.value, machineIdResult.value)) {
      sawInvalidCredentials = true;
      firstInvalidCredentialsPath ??= dbPath;
      continue;
    }

    return {
      found: true,
      accessToken: accessTokenResult.value,
      machineId: machineIdResult.value,
      dbPath,
      checkedPaths,
    };
  }

  if (sawSqliteUnavailable) {
    return {
      found: false,
      checkedPaths,
      dbPath: existingPaths[0],
      reason: 'sqlite_unavailable',
      error:
        'Cursor state database was found, but sqlite3 is not available in PATH. Install sqlite3 or use manual import.',
    };
  }

  if (sawQueryFailure) {
    return {
      found: false,
      checkedPaths,
      dbPath: firstQueryFailurePath ?? existingPaths[0],
      reason: 'db_query_failed',
      error:
        'Cursor state database was found, but CCS could not query it. The database may be locked, corrupted, or use an unexpected schema.',
    };
  }

  if (sawInvalidCredentials) {
    return {
      found: false,
      checkedPaths,
      dbPath: firstInvalidCredentialsPath ?? existingPaths[0],
      reason: 'invalid_token_format',
      error:
        'Cursor credentials were found, but the access token or machine ID format was invalid. Re-authenticate in Cursor IDE or use manual import.',
    };
  }

  if (sawMachineIdMissing) {
    return {
      found: false,
      checkedPaths,
      dbPath: existingPaths[0],
      reason: 'machine_id_not_found',
      error:
        'Cursor access token was found, but the machine ID was not present in the database. Re-open Cursor IDE or use manual import.',
    };
  }

  if (sawTokenMissing) {
    return {
      found: false,
      checkedPaths,
      dbPath: existingPaths[0],
      reason: 'access_token_not_found',
      error:
        'Access token not found in Cursor state database. Make sure you are logged in to Cursor IDE first.',
    };
  }

  return {
    found: false,
    checkedPaths,
    dbPath: existingPaths[0],
    reason: 'db_not_found',
    error: 'Cursor credentials could not be detected from the discovered database paths.',
  };
}

/**
 * Validate token and machine ID format
 */
export function validateToken(accessToken: string, machineId: string): boolean {
  // Basic validation
  if (!accessToken || typeof accessToken !== 'string') {
    return false;
  }

  if (!machineId || typeof machineId !== 'string') {
    return false;
  }

  // Token format validation (Cursor tokens are typically long strings)
  if (accessToken.length < 50) {
    return false;
  }

  // Machine ID format validation (UUID without hyphens = exactly 32 hex chars)
  const hexRegex = /^[a-f0-9]{32}$/i;
  if (!hexRegex.test(machineId.replace(/-/g, ''))) {
    return false;
  }

  return true;
}

/**
 * Extract user info from token if possible
 * Cursor tokens may contain encoded user info as JWT
 */
export function extractUserInfo(
  accessToken: string
): { email?: string; userId?: string; exp?: number } | null {
  try {
    // Try to decode as JWT
    const parts = accessToken.split('.');
    if (parts.length === 3) {
      let payload = parts[1];
      // Add padding if needed
      while (payload.length % 4) {
        payload += '=';
      }
      const decoded = JSON.parse(
        Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
      ) as Record<string, unknown>;

      const email = typeof decoded.email === 'string' ? decoded.email : undefined;
      const userId =
        typeof decoded.sub === 'string'
          ? decoded.sub
          : typeof decoded.user_id === 'string'
            ? decoded.user_id
            : undefined;
      const exp = typeof decoded.exp === 'number' ? decoded.exp : undefined;

      // If all claims are undefined, treat as if JWT parsing failed
      if (!email && !userId && exp === undefined) return null;

      return { email, userId, exp };
    }
  } catch {
    // Token is not a JWT, that's okay
  }

  return null;
}

/**
 * Get path to credentials file
 */
export function getCredentialsPath(): string {
  return path.join(getCcsDir(), 'cursor', 'credentials.json');
}

export function getCliproxyAuthDir(): string {
  return path.join(getCcsDir(), 'cliproxy', 'auth');
}

/**
 * Derive a stable 32-hex machine ID from a CLIProxy Cursor OAuth subject.
 */
export function deriveMachineIdFromCliproxySubject(subject: string): string {
  const normalized = subject.trim();
  if (!normalized) {
    throw new Error('CLIProxy Cursor auth subject is empty');
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

function resolveMachineIdForCliproxyImport(subject: string): string {
  const localMachineId = detectLocalMachineId();
  if (localMachineId) {
    return localMachineId;
  }

  return deriveMachineIdFromCliproxySubject(subject);
}

/**
 * Read a local Cursor IDE machine ID without requiring a stored access token.
 */
export function detectLocalMachineId(): string | null {
  const checkedPaths = getTokenStorageCandidates().filter((candidate) => fs.existsSync(candidate));

  for (const dbPath of checkedPaths) {
    const machineIdResult = queryStateDbKeys(dbPath, MACHINE_ID_KEYS);
    if (!machineIdResult.sqliteAvailable || machineIdResult.queryFailed || !machineIdResult.value) {
      continue;
    }

    const normalized = machineIdResult.value.replace(/-/g, '');
    if (/^[a-f0-9]{32}$/i.test(normalized)) {
      return normalized.toLowerCase();
    }
  }

  return null;
}

interface CliproxyCursorAuthRecord {
  access_token?: unknown;
  disabled?: unknown;
  sub?: unknown;
  type?: unknown;
}

function parseCliproxyCursorAuthRecord(filePath: string): CliproxyCursorAuthRecord | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as CliproxyCursorAuthRecord)
      : null;
  } catch {
    return null;
  }
}

export function findCliproxyCursorAuthFiles(authDir: string = getCliproxyAuthDir()): string[] {
  if (!fs.existsSync(authDir)) {
    return [];
  }

  return fs
    .readdirSync(authDir)
    .filter((name) => name.startsWith('cursor') && name.endsWith('.json'))
    .map((name) => path.join(authDir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}

export function importCliproxyCursorCredentials(
  options: {
    authDir?: string;
    force?: boolean;
  } = {}
): {
  imported: boolean;
  credentials?: CursorCredentials;
  sourceFile?: string;
  error?: string;
} {
  const existing = loadCredentials();
  if (existing && !options.force) {
    return {
      imported: false,
      credentials: existing,
      error: 'Native Cursor credentials already exist',
    };
  }

  const authFiles = findCliproxyCursorAuthFiles(options.authDir);
  for (const filePath of authFiles) {
    const record = parseCliproxyCursorAuthRecord(filePath);
    if (!record || record.disabled === true || record.type !== 'cursor') {
      continue;
    }

    const accessToken =
      typeof record.access_token === 'string' && record.access_token.trim().length > 0
        ? record.access_token.trim()
        : '';
    const subject = typeof record.sub === 'string' ? record.sub.trim() : '';
    if (!accessToken || !subject) {
      continue;
    }

    const machineId = resolveMachineIdForCliproxyImport(subject);
    if (!validateToken(accessToken, machineId)) {
      continue;
    }

    const credentials: CursorCredentials = {
      accessToken,
      machineId,
      authMethod: 'manual',
      importedAt: new Date().toISOString(),
      userId: subject,
    };

    saveCredentials(credentials);
    return { imported: true, credentials, sourceFile: filePath };
  }

  return {
    imported: false,
    error: 'No usable CLIProxy Cursor auth file found in cliproxy/auth',
  };
}

/**
 * Save credentials to CCS config directory
 */
export function saveCredentials(credentials: CursorCredentials): void {
  const credPath = getCredentialsPath();
  const dir = path.dirname(credPath);

  // Ensure directory exists with restrictive permissions
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Write credentials with restrictive permissions
  fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/**
 * Load credentials from CCS config directory
 */
export function loadCredentials(): CursorCredentials | null {
  const credPath = getCredentialsPath();

  if (!fs.existsSync(credPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(credPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);

    // Basic validation
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'accessToken' in parsed &&
      'machineId' in parsed &&
      'authMethod' in parsed &&
      'importedAt' in parsed
    ) {
      // Type validation
      if (
        typeof parsed.accessToken !== 'string' ||
        typeof parsed.machineId !== 'string' ||
        typeof parsed.importedAt !== 'string' ||
        (parsed.authMethod !== 'auto-detect' && parsed.authMethod !== 'manual')
      ) {
        return null;
      }

      return parsed as CursorCredentials;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check authentication status
 */
export function checkAuthStatus(): CursorAuthStatus {
  const credentials = loadCredentials();

  if (!credentials) {
    return { authenticated: false };
  }

  // Validate credentials are still valid format
  if (!validateToken(credentials.accessToken, credentials.machineId)) {
    return { authenticated: false };
  }

  // Try to get token expiry from JWT exp claim
  let tokenAge: number | undefined;
  let expired = false;
  const userInfo = extractUserInfo(credentials.accessToken);

  if (userInfo?.exp) {
    // Use JWT exp claim for expiry detection
    const now = Math.floor(Date.now() / 1000);
    expired = now >= userInfo.exp;
  }

  // Always use importedAt for tokenAge (more reliable than reverse-engineering JWT lifetime)
  const TOKEN_EXPIRY_HOURS = 24;
  const importedDate = new Date(credentials.importedAt);
  if (!isNaN(importedDate.getTime())) {
    const now = new Date();
    tokenAge = Math.floor((now.getTime() - importedDate.getTime()) / (1000 * 60 * 60));
    // Only set expired from importedAt if JWT exp was not available
    if (userInfo?.exp === undefined) {
      expired = tokenAge >= TOKEN_EXPIRY_HOURS;
    }
  }

  return {
    authenticated: true,
    credentials,
    tokenAge,
    expired,
  };
}

/**
 * Delete credentials file
 */
export function deleteCredentials(): boolean {
  try {
    fs.unlinkSync(getCredentialsPath());
    return true;
  } catch {
    return false;
  }
}
