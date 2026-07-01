import { describe, expect, it } from 'bun:test';
import {
  AssistantVisibleTextNormalizer,
  normalizeAssistantVisibleText,
  stripControlMarkers,
} from '../../../src/cursor/cursor-assistant-text-normalizer.js';

describe('cursor-assistant-text-normalizer', () => {
  it('strips final and thinking control markers', () => {
    const raw = '<｜final｜>~/agent는 여러AI코딩 도구 설정입니다.';
    expect(stripControlMarkers(raw)).toBe('~/agent는 여러AI코딩 도구 설정입니다.');
  });

  it('inserts spacing between CJK and Latin boundaries', () => {
    expect(normalizeAssistantVisibleText('여러AI코딩')).toBe('여러 AI 코딩');
    expect(normalizeAssistantVisibleText('skills)+ccteam')).toBe('skills)+ccteam');
  });

  it('formats markdown headers and table rows', () => {
    const raw = '요약입니다.##핵심 디렉터리| 경로|역할||prompts/AGENTS.md|규칙|';
    const normalized = normalizeAssistantVisibleText(raw);
    expect(normalized).toContain('## 핵심');
    expect(normalized).toContain('|\n|');
  });

  it('normalizes streamed chunks with boundary state', () => {
    const normalizer = new AssistantVisibleTextNormalizer();
    const chunks = [normalizer.push('여러'), normalizer.push('AI'), normalizer.push('코딩')];
    expect(chunks.join('')).toBe('여러 AI 코딩');
  });
});
