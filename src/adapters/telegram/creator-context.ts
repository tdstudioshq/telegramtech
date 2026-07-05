/**
 * CreatorContext (M7.0) — resolves which creator an inbound shared-bot update is
 * about, at the adapter edge. Core stays untouched: this only routes.
 *
 *  - Deep-link entry (`/start c_<slug>`) → resolve the slug → remember the creator
 *    in a per-Telegram-user session (CacheProvider; per-process for now — the same
 *    store the rate limiter uses).
 *  - Any later command → read the session, falling back to a configured default
 *    storefront so a payload-less /start still works (no discovery UI until M7.3).
 *
 * Callbacks that carry a dropId/planId don't need this — the creator is derivable
 * from the entity — so context is only consulted by browse/subscribe/library.
 */
import type { CacheProvider } from '../../core/ports/cache-provider.port.js';
import type { CreatorService } from '../../core/services/creator.service.js';
import type { Creator } from '../../shared/entities.js';
import type { CreatorId } from '../../shared/domain.js';

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const sessionKey = (telegramId: number): string => `creator-ctx:${telegramId}`;

/** A `c_<slug>` deep-link payload (or a bare slug) → the slug. */
export const parseCreatorSlug = (payload: string | null): string | null => {
  if (payload === null) return null;
  const trimmed = payload.trim();
  if (trimmed === '') return null;
  return trimmed.startsWith('c_') ? trimmed.slice(2) : trimmed;
};

export class CreatorContext {
  /** undefined = not yet resolved; null = default slug matched no creator. */
  private defaultCreatorId: CreatorId | null | undefined;

  constructor(
    private readonly cache: CacheProvider,
    private readonly creators: CreatorService,
    private readonly defaultSlug: string,
  ) {}

  /** Resolve a deep-link payload to a creator, if the slug exists. */
  async fromPayload(payload: string | null): Promise<Creator | null> {
    const slug = parseCreatorSlug(payload);
    return slug === null ? null : this.creators.findBySlug(slug);
  }

  /** Persist the current creator for this Telegram user. */
  async remember(telegramId: number, creatorId: CreatorId): Promise<void> {
    await this.cache.set(sessionKey(telegramId), creatorId, SESSION_TTL_SECONDS);
  }

  /** The creator this user is currently browsing: session, else the default storefront. */
  async current(telegramId: number): Promise<CreatorId | null> {
    const stored = await this.cache.get(sessionKey(telegramId));
    if (stored !== null) return stored;
    return this.default();
  }

  private async default(): Promise<CreatorId | null> {
    if (this.defaultCreatorId === undefined) {
      const creator = await this.creators.findBySlug(this.defaultSlug);
      this.defaultCreatorId = creator?.id ?? null;
    }
    return this.defaultCreatorId;
  }
}
