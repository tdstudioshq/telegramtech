/**
 * DiscoveryService (M7.3) — the marketplace read side. Returns PUBLIC DTOs (never
 * raw entities: no user_id/status leak) so the unauthenticated public API can serve
 * them safely. Only discoverable creators are exposed (active + slug + onboarded).
 * `startParam` (`c_<slug>`) is how a marketplace visitor routes into the Telegram
 * storefront (M7.0 deep-link); the adapter turns it into a full t.me URL.
 */
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Creator, Drop } from '../../shared/entities.js';
import type { AccessType, Stars } from '../../shared/domain.js';
import type { UnitOfWork } from '../repositories/index.js';

export interface PublicCreator {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly avatarUrl: string | null;
  readonly category: string | null;
  readonly isFeatured: boolean;
}

export interface PublicDrop {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly previewText: string | null;
  readonly accessType: AccessType;
  readonly priceStars: Stars | null;
}

export interface PublicCreatorProfile extends PublicCreator {
  readonly followerCount: number;
  /** Deep-link payload for the shared bot: `t.me/<bot>?start=<startParam>`. */
  readonly startParam: string;
  readonly drops: PublicDrop[];
}

export interface DiscoverResult {
  readonly creators: PublicCreator[];
  readonly limit: number;
  readonly offset: number;
}

export interface DiscoverInput {
  readonly query?: string;
  readonly category?: string;
  readonly limit?: number;
  readonly offset?: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(Math.trunc(value), min), max);

export class DiscoveryService {
  constructor(private readonly uow: UnitOfWork) {}

  async list(input: DiscoverInput): Promise<DiscoverResult> {
    const limit = clamp(input.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const creators = await this.uow.run(async (repos) =>
      repos.creators.listDiscoverable({ query: input.query, category: input.category, limit, offset }),
    );
    return { creators: creators.map(toPublicCreator), limit, offset };
  }

  async featured(limit = 10): Promise<PublicCreator[]> {
    const capped = clamp(limit, 1, MAX_LIMIT);
    return this.uow.run(async (repos) =>
      (await repos.creators.listFeatured(capped)).map(toPublicCreator),
    );
  }

  async categories(): Promise<string[]> {
    return this.uow.run(async (repos) => repos.creators.listCategories());
  }

  async profile(slug: string): Promise<Result<PublicCreatorProfile, AppError>> {
    return this.uow.run(async (repos) => {
      const creator = await repos.creators.findBySlug(slug);
      if (
        creator === null ||
        creator.slug === null ||
        creator.status !== 'active' ||
        creator.onboardingCompletedAt === null
      ) {
        return err(appError('not_found', 'Creator not found.', { slug }));
      }
      const drops = await repos.drops.listPublishedByCreator(creator.id);
      const followerCount = await repos.follows.countByCreator(creator.id);
      return ok({
        ...toPublicCreator(creator),
        followerCount,
        startParam: `c_${creator.slug}`,
        drops: drops.map(toPublicDrop),
      });
    });
  }
}

const toPublicCreator = (creator: Creator): PublicCreator => ({
  id: creator.id,
  slug: creator.slug ?? '',
  displayName: creator.displayName,
  bio: creator.bio,
  avatarUrl: creator.avatarUrl,
  category: creator.category,
  isFeatured: creator.isFeatured,
});

const toPublicDrop = (drop: Drop): PublicDrop => ({
  id: drop.id,
  title: drop.title,
  description: drop.description,
  previewText: drop.previewText,
  accessType: drop.accessType,
  priceStars: drop.priceStars,
});
