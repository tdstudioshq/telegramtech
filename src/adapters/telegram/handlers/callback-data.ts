import { z } from 'zod';
import type { DropId, PlanId } from '../../../shared/domain.js';

export type TelegramCallback =
  | { readonly action: 'browse'; readonly page: number }
  | { readonly action: 'detail'; readonly dropId: DropId }
  | { readonly action: 'unlock_prompt'; readonly dropId: DropId }
  | { readonly action: 'unlock'; readonly dropId: DropId }
  | { readonly action: 'subscribe_prompt'; readonly planId: PlanId }
  | { readonly action: 'subscribe'; readonly planId: PlanId };

const callbackSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('browse'), value: z.coerce.number().int().min(0) }),
  z.object({ action: z.literal('detail'), value: z.uuid() }),
  z.object({ action: z.literal('unlock_prompt'), value: z.uuid() }),
  z.object({ action: z.literal('unlock'), value: z.uuid() }),
  z.object({ action: z.literal('subscribe_prompt'), value: z.uuid() }),
  z.object({ action: z.literal('subscribe'), value: z.uuid() }),
]);

const actionCodes = {
  browse: 'b',
  detail: 'd',
  unlock_prompt: 'up',
  unlock: 'u',
  subscribe_prompt: 'sp',
  subscribe: 's',
} as const;

const codeActions = new Map<string, TelegramCallback['action']>(
  Object.entries(actionCodes).map(([action, code]) => [code, action as TelegramCallback['action']]),
);

export const callbackData = (callback: TelegramCallback): string => {
  let value: string;
  switch (callback.action) {
    case 'browse':
      value = String(callback.page);
      break;
    case 'detail':
    case 'unlock_prompt':
    case 'unlock':
      value = callback.dropId;
      break;
    case 'subscribe_prompt':
    case 'subscribe':
      value = callback.planId;
      break;
  }
  return `${actionCodes[callback.action]}:${value}`;
};

export const parseCallbackData = (data: string): TelegramCallback | null => {
  const separator = data.indexOf(':');
  if (separator < 1) return null;
  const action = codeActions.get(data.slice(0, separator));
  if (action === undefined) return null;
  const parsed = callbackSchema.safeParse({ action, value: data.slice(separator + 1) });
  if (!parsed.success) return null;
  switch (parsed.data.action) {
    case 'browse':
      return { action: 'browse', page: parsed.data.value };
    case 'detail':
    case 'unlock_prompt':
    case 'unlock':
      return { action: parsed.data.action, dropId: parsed.data.value };
    case 'subscribe_prompt':
    case 'subscribe':
      return { action: parsed.data.action, planId: parsed.data.value };
  }
};
