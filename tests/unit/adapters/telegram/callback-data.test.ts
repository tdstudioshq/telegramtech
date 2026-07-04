import { describe, expect, it } from 'vitest';
import {
  callbackData,
  parseCallbackData,
  type TelegramCallback,
} from '../../../../src/adapters/telegram/handlers/callback-data.js';

const id = '123e4567-e89b-42d3-a456-426614174000';

describe('Telegram callback data', () => {
  it.each<TelegramCallback>([
    { action: 'browse', page: 2 },
    { action: 'detail', dropId: id },
    { action: 'unlock_prompt', dropId: id },
    { action: 'unlock', dropId: id },
    { action: 'subscribe_prompt', planId: id },
    { action: 'subscribe', planId: id },
  ])('round-trips $action payloads inside Telegram limits', (callback) => {
    const encoded = callbackData(callback);
    expect(encoded.length).toBeLessThanOrEqual(64);
    expect(parseCallbackData(encoded)).toEqual(callback);
  });

  it.each(['', 'unknown:value', 'd:not-a-uuid', 'b:-1', 'b:1.5'])(
    'rejects malformed inbound payload %j',
    (payload) => {
      expect(parseCallbackData(payload)).toBeNull();
    },
  );
});
