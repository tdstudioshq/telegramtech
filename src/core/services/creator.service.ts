/**
 * CreatorService — tenant lifecycle, deliberately minimal in MVP (the single
 * creator is seeded). `requireActive` is the in-transaction guard money flows
 * use: a suspended tenant sells nothing.
 */
import { z } from 'zod';
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Creator } from '../../shared/entities.js';
import type { CreatorId, UserId } from '../../shared/domain.js';
import type { Repositories, UnitOfWork } from '../repositories/index.js';

const profilePatchSchema = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  slug: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, numbers, and hyphens only')
    .optional(),
  bio: z.string().max(2000).nullable().optional(),
  avatarUrl: z.url().nullable().optional(),
});

export type ProfilePatchInput = z.input<typeof profilePatchSchema>;

export class CreatorService {
  constructor(private readonly uow: UnitOfWork) {}

  async getById(id: CreatorId): Promise<Result<Creator, AppError>> {
    const creator = await this.uow.run(async (repos) => repos.creators.findById(id));
    return creator === null
      ? err(appError('not_found', 'Creator not found.', { creatorId: id }))
      : ok(creator);
  }

  async findByUserId(userId: UserId): Promise<Creator | null> {
    return this.uow.run(async (repos) => repos.creators.findByUserId(userId));
  }

  /** Shared-bot deep-link resolution (M7.0): map a storefront slug to its creator. */
  async findBySlug(slug: string): Promise<Creator | null> {
    return this.uow.run(async (repos) => repos.creators.findBySlug(slug));
  }

  /** Dashboard profile edit (M7.1): validate + patch only the provided fields, slug-unique. */
  async updateProfile(
    creatorId: CreatorId,
    input: ProfilePatchInput,
  ): Promise<Result<Creator, AppError>> {
    const parsed = profilePatchSchema.safeParse(input);
    if (!parsed.success) {
      return err(appError('validation', 'Please check the profile fields.', { issues: parsed.error.issues.length }));
    }
    return this.uow.run(async (repos) => {
      const existing = await repos.creators.findById(creatorId);
      if (existing === null) return err(appError('not_found', 'Creator not found.', { creatorId }));
      if (parsed.data.slug !== undefined) {
        const bySlug = await repos.creators.findBySlug(parsed.data.slug);
        if (bySlug !== null && bySlug.id !== creatorId) {
          return err(appError('conflict', 'That storefront handle is taken.', { slug: parsed.data.slug }));
        }
      }
      return ok(await repos.creators.update(creatorId, parsed.data));
    });
  }

  /** Tx-bound guard for money/access flows: the tenant must exist and be active. */
  static async requireActive(
    repos: Repositories,
    creatorId: CreatorId,
  ): Promise<Result<Creator, AppError>> {
    const creator = await repos.creators.findById(creatorId);
    if (creator === null) {
      return err(appError('not_found', 'Creator not found.', { creatorId }));
    }
    if (creator.status !== 'active') {
      return err(
        appError('forbidden', 'This creator is not currently available.', {
          creatorId,
          status: creator.status,
        }),
      );
    }
    return ok(creator);
  }
}
