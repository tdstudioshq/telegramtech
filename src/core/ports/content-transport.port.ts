/**
 * ContentTransport port — deliver content to a user on a channel. The Telegram
 * adapter implements this (M4: signed-URL upload, protect_content, transport_cache
 * write-back); a web client would implement it differently. Core hands the
 * transport the full User so channel adapters can resolve their own addressing
 * (e.g. telegramId) without core knowing about it.
 */
import type { AppError } from '../../shared/app-error.js';
import type { Result } from '../../shared/result.js';
import type { DropAsset, User } from '../../shared/entities.js';
import type { Deliverable } from './content-provider.port.js';

export type TransportContent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'media';
      /** The asset row, so transports can read/write transport_cache (rebuildable, never authoritative). */
      readonly asset: DropAsset;
      readonly deliverable: Deliverable;
    };

export interface SendOptions {
  /** Always true for paid content (protect_content on Telegram). */
  readonly protect: boolean;
}

export interface ContentTransport {
  send(user: User, content: TransportContent, options: SendOptions): Promise<Result<void, AppError>>;
}
