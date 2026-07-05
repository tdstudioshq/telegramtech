/**
 * AuthService (M7.1) — creator web/API identity + opaque bearer sessions. Built to
 * be reused by every future client (SPA, mobile, public API): they all register /
 * log in / authenticate through here. Crypto lives behind ports (PasswordHasher,
 * SessionTokenService) so the service stays pure and unit-testable.
 *
 * A creator registered here has NO Telegram user (creators.user_id is null since
 * M7.1); the identity is the owner. Passwords are hashed OUTSIDE the transaction
 * (CPU-bound); token issue/hash is pure and happens in-tx.
 */
import { z } from 'zod';
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { Creator } from '../../shared/entities.js';
import type { CreatorId } from '../../shared/domain.js';
import type { Clock } from '../ports/clock.port.js';
import type { PasswordHasher } from '../ports/password-hasher.port.js';
import type { SessionTokenService } from '../ports/session-token.port.js';
import type { Repositories, UnitOfWork } from '../repositories/index.js';
import { AuditService } from './audit.service.js';

const slugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, numbers, and hyphens only');

const registerSchema = z.object({
  email: z.email().transform((value) => value.trim().toLowerCase()),
  password: z.string().min(8).max(200),
  displayName: z.string().trim().min(1).max(100),
  slug: slugSchema.optional(),
});

export type RegisterInput = z.input<typeof registerSchema>;

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

export interface AuthResult {
  readonly token: string;
  readonly creator: Creator;
}

/** Who a validated session belongs to — attached to authenticated API requests. */
export interface AuthPrincipal {
  readonly identityId: string;
  readonly creatorId: CreatorId;
  readonly email: string;
}

export class AuthService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly hasher: PasswordHasher,
    private readonly tokens: SessionTokenService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly sessionTtlHours: number,
  ) {}

  async register(input: RegisterInput): Promise<Result<AuthResult, AppError>> {
    const parsed = registerSchema.safeParse(input);
    if (!parsed.success) {
      return err(appError('validation', 'Please check your details and try again.', flatten(parsed.error)));
    }
    const { email, password, displayName, slug } = parsed.data;
    const passwordHash = await this.hasher.hash(password); // outside the transaction

    return this.uow.run(async (repos) => {
      if ((await repos.creatorIdentities.findByEmail(email)) !== null) {
        return err(appError('conflict', 'An account with this email already exists.', { email }));
      }
      if (slug !== undefined && (await repos.creators.findBySlug(slug)) !== null) {
        return err(appError('conflict', 'That storefront handle is taken.', { slug }));
      }

      const creator = await repos.creators.create({
        displayName,
        slug: slug ?? null,
        status: 'active',
      });
      const identity = await repos.creatorIdentities.create({
        creatorId: creator.id,
        email,
        passwordHash,
      });
      await this.audit.record(repos, {
        creatorId: creator.id,
        action: 'creator.registered',
        entityType: 'creator',
        entityId: creator.id,
        actorType: 'system',
        context: { email },
      });
      const token = await this.issueSession(repos, identity.id);
      return ok({ token, creator });
    });
  }

  async login(input: LoginInput): Promise<Result<AuthResult, AppError>> {
    const email = input.email.trim().toLowerCase();
    const identity = await this.uow.run(async (repos) => repos.creatorIdentities.findByEmail(email));
    // Same error whether the email is unknown or the password is wrong (no enumeration).
    const invalid = err(appError('unauthorized', 'Invalid email or password.'));
    if (identity === null) return invalid;
    if (!(await this.hasher.verify(input.password, identity.passwordHash))) return invalid;

    return this.uow.run(async (repos) => {
      const creator = await repos.creators.findById(identity.creatorId);
      if (creator === null) return err(appError('not_found', 'Creator account not found.'));
      const token = await this.issueSession(repos, identity.id);
      return ok({ token, creator });
    });
  }

  /** Validate a bearer token → the principal, or null if missing/expired/unknown. */
  async authenticate(token: string): Promise<AuthPrincipal | null> {
    const tokenHash = this.tokens.hash(token);
    return this.uow.run(async (repos) => {
      const session = await repos.sessions.findByTokenHash(tokenHash);
      if (session === null || session.expiresAt.getTime() <= this.clock.now().getTime()) return null;
      const identity = await repos.creatorIdentities.findById(session.identityId);
      if (identity === null) return null;
      return { identityId: identity.id, creatorId: identity.creatorId, email: identity.email };
    });
  }

  async logout(token: string): Promise<void> {
    const tokenHash = this.tokens.hash(token);
    await this.uow.run(async (repos) => repos.sessions.deleteByTokenHash(tokenHash));
  }

  private async issueSession(repos: Repositories, identityId: string): Promise<string> {
    const { token, tokenHash } = this.tokens.issue();
    const expiresAt = new Date(this.clock.now().getTime() + this.sessionTtlHours * 3_600_000);
    await repos.sessions.create({ identityId, tokenHash, expiresAt });
    return token;
  }
}

const flatten = (error: z.ZodError): Record<string, string> => {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '(root)';
    fields[key] ??= issue.message;
  }
  return fields;
};
