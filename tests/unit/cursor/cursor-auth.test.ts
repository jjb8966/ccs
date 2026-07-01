/**
 * Unit tests for Cursor authentication module
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CursorCredentials } from '../../../src/cursor/types';
import {
  validateToken,
  extractUserInfo,
  saveCredentials,
  loadCredentials,
  checkAuthStatus,
  deleteCredentials,
  autoDetectTokens,
  getTokenStorageCandidates,
  deriveMachineIdFromCliproxySubject,
  findCliproxyCursorAuthFiles,
  importCliproxyCursorCredentials,
  getCliproxyAuthDir,
} from '../../../src/cursor/cursor-auth';

// Test isolation
let originalCcsHome: string | undefined;
let originalCcsDir: string | undefined;
let tempDir: string;

beforeEach(() => {
  // Save original CCS_HOME/CCS_DIR
  originalCcsHome = process.env.CCS_HOME;
  originalCcsDir = process.env.CCS_DIR;

  // Create temp directory for test isolation
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-cursor-test-'));
  delete process.env.CCS_DIR;
  process.env.CCS_HOME = tempDir;
});

afterEach(() => {
  // Restore original CCS_HOME/CCS_DIR
  if (originalCcsHome !== undefined) {
    process.env.CCS_HOME = originalCcsHome;
  } else {
    delete process.env.CCS_HOME;
  }

  if (originalCcsDir !== undefined) {
    process.env.CCS_DIR = originalCcsDir;
  } else {
    delete process.env.CCS_DIR;
  }

  // Clean up temp directory
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe('validateToken', () => {
  it('should accept valid token and machineId', () => {
    const token = 'a'.repeat(50); // 50 chars minimum
    const machineId = 'a'.repeat(32); // 32 hex chars
    expect(validateToken(token, machineId)).toBe(true);
  });

  it('should reject 49-char token (too short)', () => {
    const token = 'a'.repeat(49); // Just under minimum
    const machineId = 'a'.repeat(32);
    expect(validateToken(token, machineId)).toBe(false);
  });

  it('should reject 31-char hex UUID (too short)', () => {
    const token = 'a'.repeat(50);
    const machineId = 'a'.repeat(31); // Just under 32
    expect(validateToken(token, machineId)).toBe(false);
  });

  it('should accept UUID with hyphens (strips them)', () => {
    const token = 'a'.repeat(50);
    const machineId = '12345678-1234-1234-1234-123456789abc'; // 36 chars with hyphens
    expect(validateToken(token, machineId)).toBe(true);
  });

  it('should reject empty token', () => {
    const machineId = 'a'.repeat(32);
    expect(validateToken('', machineId)).toBe(false);
  });

  it('should reject empty machineId', () => {
    const token = 'a'.repeat(50);
    expect(validateToken(token, '')).toBe(false);
  });

  it('should reject non-hex characters in machineId', () => {
    const token = 'a'.repeat(50);
    const machineId = 'g'.repeat(32); // 'g' is not valid hex
    expect(validateToken(token, machineId)).toBe(false);
  });
});

describe('extractUserInfo', () => {
  it('should extract email and sub from valid JWT', () => {
    // JWT: {"email":"user@example.com","sub":"12345","exp":1234567890}
    const payload = Buffer.from(
      JSON.stringify({ email: 'user@example.com', sub: '12345', exp: 1234567890 })
    ).toString('base64');
    const token = `header.${payload}.signature`;

    const result = extractUserInfo(token);
    expect(result).toEqual({
      email: 'user@example.com',
      userId: '12345',
      exp: 1234567890,
    });
  });

  it('should return undefined email when only sub claim exists', () => {
    // JWT: {"sub":"uuid-12345","exp":1234567890}
    const payload = Buffer.from(JSON.stringify({ sub: 'uuid-12345', exp: 1234567890 })).toString(
      'base64'
    );
    const token = `header.${payload}.signature`;

    const result = extractUserInfo(token);
    expect(result).toEqual({
      email: undefined,
      userId: 'uuid-12345',
      exp: 1234567890,
    });
  });

  it('should return null for non-JWT token', () => {
    const token = 'a'.repeat(50); // Plain token
    const result = extractUserInfo(token);
    expect(result).toBe(null);
  });

  it('should return null for malformed base64', () => {
    const token = 'header.!!!invalid-base64!!!.signature';
    const result = extractUserInfo(token);
    expect(result).toBe(null);
  });

  it('should handle JWT with user_id instead of sub', () => {
    // JWT: {"email":"user@example.com","user_id":"67890"}
    const payload = Buffer.from(
      JSON.stringify({ email: 'user@example.com', user_id: '67890' })
    ).toString('base64');
    const token = `header.${payload}.signature`;

    const result = extractUserInfo(token);
    expect(result).toEqual({
      email: 'user@example.com',
      userId: '67890',
      exp: undefined,
    });
  });

  it('should return null for JWT with no meaningful claims', () => {
    // JWT: {"iat":1234567890} (only issued-at, no email/sub/exp)
    const payload = Buffer.from(JSON.stringify({ iat: 1234567890 })).toString('base64');
    const token = `header.${payload}.signature`;

    const result = extractUserInfo(token);
    expect(result).toBe(null);
  });
});

describe('saveCredentials and loadCredentials', () => {
  it('should save and load credentials successfully', () => {
    const credentials: CursorCredentials = {
      accessToken: 'a'.repeat(50),
      machineId: 'b'.repeat(32),
      authMethod: 'auto-detect',
      importedAt: new Date().toISOString(),
    };

    saveCredentials(credentials);
    const loaded = loadCredentials();

    expect(loaded).toEqual(credentials);
  });

  it('should return null when no credentials file exists', () => {
    const loaded = loadCredentials();
    expect(loaded).toBe(null);
  });

  it('should create directory with restrictive permissions', () => {
    const credentials: CursorCredentials = {
      accessToken: 'a'.repeat(50),
      machineId: 'b'.repeat(32),
      authMethod: 'manual',
      importedAt: new Date().toISOString(),
    };

    saveCredentials(credentials);

    // CCS_HOME is set to tempDir, but getCcsDir() appends '.ccs' to it
    const credDir = path.join(tempDir, '.ccs', 'cursor');
    expect(fs.existsSync(credDir)).toBe(true);

    // Check directory permissions (skip on Windows)
    if (process.platform !== 'win32') {
      const stats = fs.statSync(credDir);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  it('should return null for invalid JSON in credentials file', () => {
    // CCS_HOME is set to tempDir, getCcsDir() returns path.join(tempDir, '.ccs')
    const credDir = path.join(tempDir, '.ccs', 'cursor');
    const credPath = path.join(credDir, 'credentials.json');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(credPath, 'invalid json{{{');

    const loaded = loadCredentials();
    expect(loaded).toBe(null);
  });

  it('should return null for credentials missing required fields', () => {
    const credDir = path.join(tempDir, '.ccs', 'cursor');
    const credPath = path.join(credDir, 'credentials.json');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        accessToken: 'token',
        // Missing machineId, authMethod, importedAt
      })
    );

    const loaded = loadCredentials();
    expect(loaded).toBe(null);
  });

  it('should return null for credentials with wrong types', () => {
    const credDir = path.join(tempDir, '.ccs', 'cursor');
    const credPath = path.join(credDir, 'credentials.json');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        accessToken: 123, // Wrong type (number instead of string)
        machineId: 'abc',
        authMethod: 'auto-detect',
        importedAt: new Date().toISOString(),
      })
    );

    const loaded = loadCredentials();
    expect(loaded).toBe(null);
  });

  it('should return null for invalid authMethod', () => {
    const credDir = path.join(tempDir, '.ccs', 'cursor');
    const credPath = path.join(credDir, 'credentials.json');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(
      credPath,
      JSON.stringify({
        accessToken: 'token',
        machineId: 'abc',
        authMethod: 'invalid-method', // Invalid authMethod
        importedAt: new Date().toISOString(),
      })
    );

    const loaded = loadCredentials();
    expect(loaded).toBe(null);
  });
});

describe('checkAuthStatus', () => {
  it('should return not authenticated when no credentials exist', () => {
    const status = checkAuthStatus();
    expect(status.authenticated).toBe(false);
    expect(status.credentials).toBeUndefined();
  });

  it('should return authenticated for valid credentials', () => {
    const credentials: CursorCredentials = {
      accessToken: 'a'.repeat(50),
      machineId: 'b'.repeat(32),
      authMethod: 'auto-detect',
      importedAt: new Date().toISOString(),
    };

    saveCredentials(credentials);
    const status = checkAuthStatus();

    expect(status.authenticated).toBe(true);
    expect(status.credentials).toEqual(credentials);
    expect(status.expired).toBe(false);
    expect(status.tokenAge).toBeDefined();
    expect(status.tokenAge).toBeLessThan(1); // Just imported
  });

  it('should detect expired credentials (importedAt > 24h ago)', () => {
    // Create credentials from 25 hours ago
    const past = new Date();
    past.setHours(past.getHours() - 25);

    const credentials: CursorCredentials = {
      accessToken: 'a'.repeat(50),
      machineId: 'b'.repeat(32),
      authMethod: 'manual',
      importedAt: past.toISOString(),
    };

    saveCredentials(credentials);
    const status = checkAuthStatus();

    expect(status.authenticated).toBe(true);
    expect(status.expired).toBe(true);
    expect(status.tokenAge).toBeGreaterThanOrEqual(24);
  });

  it('should return not authenticated for invalid token format', () => {
    const credentials: CursorCredentials = {
      accessToken: 'short', // Invalid (too short)
      machineId: 'b'.repeat(32),
      authMethod: 'manual',
      importedAt: new Date().toISOString(),
    };

    saveCredentials(credentials);
    const status = checkAuthStatus();

    expect(status.authenticated).toBe(false);
  });

  it('should use JWT exp claim when available', () => {
    // Create JWT token that expired 1 hour ago
    const expiredTime = Math.floor(Date.now() / 1000) - 3600;
    const payload = Buffer.from(
      JSON.stringify({ email: 'test@example.com', sub: '123', exp: expiredTime })
    ).toString('base64');
    const jwtToken = `header.${payload}.signature`;

    const credentials: CursorCredentials = {
      accessToken: jwtToken,
      machineId: 'b'.repeat(32),
      authMethod: 'auto-detect',
      importedAt: new Date().toISOString(), // Recent import
    };

    saveCredentials(credentials);
    const status = checkAuthStatus();

    expect(status.authenticated).toBe(true);
    expect(status.expired).toBe(true); // Should detect expiry from JWT exp
  });

  it('should handle invalid importedAt date gracefully', () => {
    // Create credentials with valid format but garbage date value
    const credentials: CursorCredentials = {
      accessToken: 'a'.repeat(50),
      machineId: 'b'.repeat(32),
      authMethod: 'manual',
      importedAt: 'invalid-date-garbage-2026-99-99T99:99:99Z',
    };

    saveCredentials(credentials);
    const status = checkAuthStatus();

    // Should still authenticate if token format is valid
    expect(status.authenticated).toBe(true);
    // tokenAge should be undefined due to invalid date (NaN from getTime())
    expect(status.tokenAge).toBeUndefined();
    // expired should be false (defaults to false when date parsing fails)
    expect(status.expired).toBe(false);
  });
});

describe('deleteCredentials', () => {
  it('should delete existing credentials file and return true', () => {
    const credentials: CursorCredentials = {
      accessToken: 'a'.repeat(50),
      machineId: 'b'.repeat(32),
      authMethod: 'auto-detect',
      importedAt: new Date().toISOString(),
    };

    saveCredentials(credentials);
    expect(loadCredentials()).not.toBe(null);

    const result = deleteCredentials();
    expect(result).toBe(true);
    expect(loadCredentials()).toBe(null);
  });

  it('should return false when credentials file does not exist', () => {
    const result = deleteCredentials();
    expect(result).toBe(false);
  });

  it('should handle multiple delete calls gracefully', () => {
    const credentials: CursorCredentials = {
      accessToken: 'a'.repeat(50),
      machineId: 'b'.repeat(32),
      authMethod: 'manual',
      importedAt: new Date().toISOString(),
    };

    saveCredentials(credentials);

    // First delete should succeed
    expect(deleteCredentials()).toBe(true);

    // Second delete should return false (already deleted)
    expect(deleteCredentials()).toBe(false);
  });
});

describe('autoDetectTokens', () => {
  it('should report checked paths when no Windows database exists', () => {
    const originalPlatform = process.platform;
    const originalUserProfile = process.env.USERPROFILE;
    const originalAppData = process.env.APPDATA;
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const fakeHome = path.join(tempDir, 'win-home');
    process.env.USERPROFILE = fakeHome;
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;

    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    try {
      const result = autoDetectTokens();

      expect(result.found).toBe(false);
      expect(result.reason).toBe('db_not_found');
      expect(result.checkedPaths?.length).toBeGreaterThan(0);
      expect(result.error).toContain('Checked:');
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
      if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;
      if (originalAppData !== undefined) process.env.APPDATA = originalAppData;
      else delete process.env.APPDATA;
      if (originalLocalAppData !== undefined) process.env.LOCALAPPDATA = originalLocalAppData;
      else delete process.env.LOCALAPPDATA;
    }
  });

  it('should return not found when database file does not exist', () => {
    // Skip on Windows (already covered by previous test)
    if (process.platform === 'win32') {
      return;
    }

    const originalHome = process.env.HOME;
    const isolatedHome = path.join(tempDir, 'no-cursor-home');
    process.env.HOME = isolatedHome;

    try {
      const result = autoDetectTokens();

      expect(result.found).toBe(false);
      expect(result.reason).toBe('db_not_found');
      expect(result.checkedPaths?.length).toBeGreaterThan(0);
      expect(result.error).toContain('Checked:');
    } finally {
      if (originalHome !== undefined) {
        process.env.HOME = originalHome;
      } else {
        delete process.env.HOME;
      }
    }
  });

  it('should have found property in return type', () => {
    const result = autoDetectTokens();

    // Verify return type structure
    expect(result).toHaveProperty('found');
    expect(typeof result.found).toBe('boolean');
  });

  it('should report sqlite_unavailable when database exists but sqlite3 is missing', () => {
    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    const originalSqliteBin = process.env.CCS_CURSOR_SQLITE_BIN;
    const fakeHome = path.join(tempDir, 'sqlite-missing-home');
    process.env.HOME = fakeHome;
    process.env.CCS_CURSOR_SQLITE_BIN = 'definitely-missing-sqlite3';

    try {
      const dbPath = getTokenStorageCandidates()[0];
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, '');

      const result = autoDetectTokens();
      expect(result.found).toBe(false);
      expect(result.reason).toBe('sqlite_unavailable');
      expect(result.dbPath).toBe(dbPath);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
      if (originalSqliteBin !== undefined) process.env.CCS_CURSOR_SQLITE_BIN = originalSqliteBin;
      else delete process.env.CCS_CURSOR_SQLITE_BIN;
    }
  });

  it('should use fallback keys and normalize JSON-encoded sqlite values', () => {
    if (process.platform === 'win32') return;

    try {
      execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    } catch {
      return;
    }

    const originalHome = process.env.HOME;
    const fakeHome = path.join(tempDir, 'sqlite-fallback-home');
    process.env.HOME = fakeHome;

    try {
      const dbPath = getTokenStorageCandidates()[0];
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      execFileSync('sqlite3', [
        dbPath,
        'CREATE TABLE IF NOT EXISTS itemTable (key TEXT PRIMARY KEY, value TEXT);',
      ]);
      execFileSync('sqlite3', [
        dbPath,
        `INSERT OR REPLACE INTO itemTable (key, value) VALUES ('cursorAuth/token', '"${'a'.repeat(60)}"');`,
      ]);
      execFileSync('sqlite3', [
        dbPath,
        `INSERT OR REPLACE INTO itemTable (key, value) VALUES ('storage.machineId', '"1234567890abcdef1234567890abcdef"');`,
      ]);

      const result = autoDetectTokens();
      expect(result.found).toBe(true);
      expect(result.accessToken).toBe('a'.repeat(60));
      expect(result.machineId).toBe('1234567890abcdef1234567890abcdef');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });

  it('should continue scanning later database candidates after one invalid credential pair', () => {
    if (process.platform !== 'darwin') {
      return;
    }

    try {
      execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    } catch {
      return;
    }

    const originalHome = process.env.HOME;
    const fakeHome = path.join(tempDir, 'candidate-scan-home');
    process.env.HOME = fakeHome;

    try {
      const [stablePath, insidersPath] = getTokenStorageCandidates();
      fs.mkdirSync(path.dirname(stablePath), { recursive: true });
      fs.mkdirSync(path.dirname(insidersPath), { recursive: true });

      execFileSync('sqlite3', [
        stablePath,
        'CREATE TABLE IF NOT EXISTS itemTable (key TEXT PRIMARY KEY, value TEXT);',
      ]);
      execFileSync('sqlite3', [
        stablePath,
        `INSERT OR REPLACE INTO itemTable (key, value) VALUES ('cursorAuth/accessToken', 'short');`,
      ]);
      execFileSync('sqlite3', [
        stablePath,
        `INSERT OR REPLACE INTO itemTable (key, value) VALUES ('storage.serviceMachineId', 'bad');`,
      ]);

      execFileSync('sqlite3', [
        insidersPath,
        'CREATE TABLE IF NOT EXISTS itemTable (key TEXT PRIMARY KEY, value TEXT);',
      ]);
      execFileSync('sqlite3', [
        insidersPath,
        `INSERT OR REPLACE INTO itemTable (key, value) VALUES ('cursorAuth/accessToken', '${'a'.repeat(60)}');`,
      ]);
      execFileSync('sqlite3', [
        insidersPath,
        `INSERT OR REPLACE INTO itemTable (key, value) VALUES ('storage.serviceMachineId', '1234567890abcdef1234567890abcdef');`,
      ]);

      const result = autoDetectTokens();
      expect(result.found).toBe(true);
      expect(result.dbPath).toBe(insidersPath);
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });

  it('should report db_query_failed when the database exists but sqlite cannot query it', () => {
    if (process.platform === 'win32') return;

    try {
      execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
    } catch {
      return;
    }

    const originalHome = process.env.HOME;
    const fakeHome = path.join(tempDir, 'query-failed-home');
    process.env.HOME = fakeHome;

    try {
      const dbPath = getTokenStorageCandidates()[0];
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, 'not-a-sqlite-database');

      const result = autoDetectTokens();
      expect(result.found).toBe(false);
      expect(result.reason).toBe('db_query_failed');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});

describe('importCliproxyCursorCredentials', () => {
  it('derives a stable machine ID from CLIProxy subject', () => {
    const first = deriveMachineIdFromCliproxySubject('google-oauth2|user_01KW6VQTDV4ZEYMTBHJ56V8V1J');
    const second = deriveMachineIdFromCliproxySubject('google-oauth2|user_01KW6VQTDV4ZEYMTBHJ56V8V1J');
    expect(first).toHaveLength(32);
    expect(first).toBe(second);
  });

  it('imports credentials from cliproxy auth storage', () => {
    const authDir = path.join(tempDir, 'cliproxy', 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const token = 'a'.repeat(50);
    fs.writeFileSync(
      path.join(authDir, 'cursor.test.json'),
      JSON.stringify({
        access_token: token,
        sub: 'google-oauth2|user_test',
        type: 'cursor',
        disabled: false,
      })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = path.join(tempDir, 'isolated-home');
    try {
      const result = importCliproxyCursorCredentials({ authDir, force: true });
      expect(result.imported).toBe(true);
      expect(result.credentials?.accessToken).toBe(token);
      expect(result.credentials?.machineId).toBe(
        deriveMachineIdFromCliproxySubject('google-oauth2|user_test')
      );
      expect(loadCredentials()?.machineId).toBe(result.credentials?.machineId);
      expect(findCliproxyCursorAuthFiles(authDir)).toHaveLength(1);
      expect(getCliproxyAuthDir()).toContain('cliproxy');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });

  it('prefers a local Cursor IDE machine ID when importing CLIProxy credentials', () => {
    const authDir = path.join(tempDir, 'cliproxy', 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    const token = 'a'.repeat(50);
    fs.writeFileSync(
      path.join(authDir, 'cursor.test.json'),
      JSON.stringify({
        access_token: token,
        sub: 'google-oauth2|user_test',
        type: 'cursor',
        disabled: false,
      })
    );

    const originalHome = process.env.HOME;
    const fakeHome = path.join(tempDir, 'fake-home');
    process.env.HOME = fakeHome;
    const dbPath = path.join(
      fakeHome,
      'Library/Application Support/Cursor/User/globalStorage/state.vscdb'
    );
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    try {
      if (process.platform === 'win32') {
        return;
      }
      execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
      execFileSync(
        'sqlite3',
        [dbPath, "CREATE TABLE itemTable (key TEXT, value TEXT); INSERT INTO itemTable VALUES ('storage.serviceMachineId', 'abcdef0123456789abcdef0123456789');"],
        { stdio: 'ignore' }
      );

      const result = importCliproxyCursorCredentials({ authDir, force: true });
      expect(result.imported).toBe(true);
      expect(result.credentials?.machineId).toBe('abcdef0123456789abcdef0123456789');
    } finally {
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
    }
  });
});
