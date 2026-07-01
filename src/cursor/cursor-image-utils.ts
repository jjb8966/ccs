/**
 * Image parsing utilities for Cursor protobuf encoding.
 */

import type { CursorMessageImage } from './cursor-protobuf-schema.js';

export type { CursorMessageImage };

const DATA_IMAGE_URL_PATTERN = /^data:([^;]+);base64,(.+)$/s;

export function parseDataImageUrl(url: string): CursorMessageImage | null {
  const match = url.match(DATA_IMAGE_URL_PATTERN);
  if (!match) {
    return null;
  }

  const data = Uint8Array.from(Buffer.from(match[2], 'base64'));
  if (data.length === 0) {
    return null;
  }

  return { data };
}

export async function fetchImageFromUrl(
  url: string,
  signal?: AbortSignal
): Promise<CursorMessageImage> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch image URL (${response.status})`);
  }

  const data = new Uint8Array(await response.arrayBuffer());
  if (data.length === 0) {
    throw new Error('Fetched image URL returned empty body');
  }

  return { data };
}

export async function resolveImageUrl(
  url: string,
  signal?: AbortSignal
): Promise<CursorMessageImage> {
  const parsed = parseDataImageUrl(url);
  if (parsed) {
    return parsed;
  }

  if (/^https?:\/\//i.test(url)) {
    return fetchImageFromUrl(url, signal);
  }

  throw new Error(
    'Unsupported image URL format; expected data:image/...;base64,... or http(s) URL'
  );
}

interface OpenAIImageUrlPart {
  type: 'image_url';
  image_url?: {
    url?: string;
  };
}

function isImageUrlPart(part: unknown): part is OpenAIImageUrlPart {
  return (
    typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image_url'
  );
}

export function extractImagesFromOpenAIContent(
  content: string | unknown[] | undefined
): CursorMessageImage[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const images: CursorMessageImage[] = [];
  for (const part of content) {
    if (!isImageUrlPart(part)) {
      continue;
    }

    const url = part.image_url?.url;
    if (typeof url !== 'string' || url.length === 0) {
      continue;
    }

    const parsed = parseDataImageUrl(url);
    if (parsed) {
      images.push(parsed);
    }
  }

  return images;
}

export async function resolveRemoteImageUrlsInBody<
  T extends {
    messages: Array<{
      role: string;
      content: string | Array<{ type: string; text?: string; image_url?: { url?: string } }>;
      name?: string;
      tool_call_id?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    }>;
    tools?: unknown[];
    reasoning_effort?: string;
  },
>(body: T, signal?: AbortSignal): Promise<T> {
  const messages = await Promise.all(
    body.messages.map(async (message) => {
      if (!Array.isArray(message.content)) {
        return message;
      }

      const content = await Promise.all(
        message.content.map(async (part) => {
          if (part.type !== 'image_url' || !part.image_url?.url) {
            return part;
          }

          const url = part.image_url.url;
          if (parseDataImageUrl(url)) {
            return part;
          }

          if (!/^https?:\/\//i.test(url)) {
            return part;
          }

          const image = await resolveImageUrl(url, signal);
          const mediaType = guessImageMimeType(image.data) ?? 'image/png';
          return {
            ...part,
            image_url: {
              ...part.image_url,
              url: `data:${mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
            },
          };
        })
      );

      return { ...message, content };
    })
  );

  return { ...body, messages };
}

function guessImageMimeType(data: Uint8Array): string | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    data.length >= 6 &&
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}
