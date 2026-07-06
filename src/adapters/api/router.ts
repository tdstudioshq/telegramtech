/**
 * JSON API adapter (M7.1) — the dashboard's transport. Like the Telegram adapter,
 * it holds NO business logic: every route validates its payload then calls a core
 * service with the authenticated creator's id (creator isolation). A future SPA,
 * mobile app, or public API reuse these same services through AuthService.
 *
 * Auth: opaque bearer token (Authorization: Bearer <token>) → AuthService.authenticate
 * → principal.creatorId. Public routes: register + login only.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { CacheProvider } from '../../core/ports/cache-provider.port.js';
import type { ContentProvider } from '../../core/ports/content-provider.port.js';
import type { AnalyticsService } from '../../core/services/analytics.service.js';
import type {
  AuthPrincipal,
  AuthService,
  RegisterInput,
} from '../../core/services/auth.service.js';
import type { CreatorService, ProfilePatchInput } from '../../core/services/creator.service.js';
import type {
  DiscoveryService,
  PublicCreatorProfile,
} from '../../core/services/discovery.service.js';
import type { DropService } from '../../core/services/drop.service.js';
import type { OnboardingService } from '../../core/services/onboarding.service.js';
import type { SubscriptionService } from '../../core/services/subscription.service.js';
import type { Logger } from '../../logging/logger.js';
import { appError } from '../../shared/app-error.js';
import { ACCESS_TYPES, CONTENT_TYPES, type ContentType } from '../../shared/domain.js';
import {
  bearerToken,
  readJsonBody,
  readRawBody,
  sendError,
  sendJson,
  sendRateLimited,
  sendResult,
} from './http.js';
import { checkRateLimit, clientIp, type ApiRateLimits, type RateLimitRule } from './rate-limit.js';

/**
 * The handler shape this adapter produces — a plain Node http handler. Defined here
 * (the producer) rather than imported from the composition/server zone, so the api
 * adapter never depends on server/ (dependency direction stays composition→adapter,
 * ESLint-enforced). Structurally identical to server's MountedApp.handler.
 */
export type HttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface ApiDependencies {
  readonly auth: AuthService;
  readonly creators: CreatorService;
  readonly drops: DropService;
  readonly subscriptions: SubscriptionService;
  readonly analytics: AnalyticsService;
  readonly onboarding: OnboardingService;
  readonly discovery: DiscoveryService;
  readonly content: ContentProvider;
  /** Shared-bot @username for building storefront deep-links; null = omit the URL. */
  readonly botUsername: string | null;
  /** CacheProvider-backed request throttling (shared with the Telegram limiter primitive). */
  readonly cache: CacheProvider;
  readonly rateLimits: ApiRateLimits;
  /** Appending reverse proxies in front of the app (Railway edge = 1) — for client-IP resolution. */
  readonly trustedProxyHops: number;
  readonly logger: Logger;
}

const loginBody = z.object({ email: z.string(), password: z.string() });
const createDropBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  previewText: z.string().max(500).nullish(),
  accessType: z.enum(ACCESS_TYPES),
  priceStars: z.number().int().positive().nullish(),
});
const createPlanBody = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).nullish(),
  priceStars: z.number().int().positive(),
  durationDays: z.number().int().positive(),
});
const uploadableType = z.enum(CONTENT_TYPES).exclude(['text']);

const PUBLISH_RE = /^\/api\/content\/drops\/([^/]+)\/publish$/;
const ASSETS_RE = /^\/api\/content\/drops\/([^/]+)\/assets$/;
const PUBLIC_PROFILE_RE = /^\/api\/public\/creators\/([^/]+)$/;

const intParam = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** Attach a full t.me deep-link to a public profile when the bot username is known. */
const withDeepLink = (
  profile: PublicCreatorProfile,
  botUsername: string | null,
): PublicCreatorProfile & { telegramUrl: string | null } => ({
  ...profile,
  telegramUrl:
    botUsername === null ? null : `https://t.me/${botUsername}?start=${profile.startParam}`,
});

/** Enforce a rate-limit bucket; if exhausted, send a 429 and return true (caller returns). */
const limited = async (
  deps: ApiDependencies,
  res: ServerResponse,
  key: string,
  rule: RateLimitRule,
): Promise<boolean> => {
  const verdict = await checkRateLimit(deps.cache, key, rule);
  if (verdict.degraded) {
    deps.logger.warn({ key }, 'rate-limit cache unavailable — allowing (fail-open)');
  }
  if (verdict.allowed) return false;
  sendRateLimited(res, verdict.retryAfterSeconds);
  return true;
};

export const createApiHandler = (deps: ApiDependencies): HttpRequestHandler => {
  return async (req, res) => {
    try {
      await route(deps, req, res);
    } catch (error) {
      deps.logger.error({ err: error }, 'api request failed');
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong.' } });
      }
    }
  };
};

const route = async (
  deps: ApiDependencies,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const method = req.method ?? 'GET';
  const path = (req.url ?? '/').split('?')[0]?.replace(/\/+$/, '') || '/';
  // Validated client IP (rightmost trusted-proxy hop), used for all IP-keyed buckets.
  const ip = clientIp(req, deps.trustedProxyHops);

  // ---- public marketplace routes (no auth, read-only) ----
  // Throttle the unauthenticated read surface per IP before any DB work (incl. the
  // pg_trgm ILIKE search) so it can't be flooded to drive DB load.
  if (path.startsWith('/api/public/')) {
    if (await limited(deps, res, `rate:api:public:${ip}`, deps.rateLimits.public)) return;
  }
  if (method === 'GET' && path === '/api/public/creators/featured') {
    return sendJson(res, 200, { creators: await deps.discovery.featured() });
  }
  if (method === 'GET' && path === '/api/public/categories') {
    return sendJson(res, 200, { categories: await deps.discovery.categories() });
  }
  if (method === 'GET' && path === '/api/public/creators') {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    return sendJson(
      res,
      200,
      await deps.discovery.list({
        query: params.get('query') ?? undefined,
        category: params.get('category') ?? undefined,
        limit: intParam(params.get('limit')),
        offset: intParam(params.get('offset')),
      }),
    );
  }
  const publicProfile = method === 'GET' ? PUBLIC_PROFILE_RE.exec(path) : null;
  if (publicProfile) {
    const result = await deps.discovery.profile(decodeURIComponent(publicProfile[1] ?? ''));
    if (!result.ok) return sendError(res, result.error);
    return sendJson(res, 200, withDeepLink(result.value, deps.botUsername));
  }

  // ---- auth (public) ----
  // Throttle by client IP BEFORE running scrypt so a flood can't exhaust the KDF
  // threadpool (shared, single-replica) or brute-force credentials.
  if (method === 'POST' && path === '/api/auth/register') {
    if (await limited(deps, res, `rate:api:auth:ip:${ip}`, deps.rateLimits.auth)) return;
    const body = (await readJsonBody(req)) as RegisterInput;
    return sendResult(res, await deps.auth.register(body), 201);
  }
  if (method === 'POST' && path === '/api/auth/login') {
    if (await limited(deps, res, `rate:api:auth:ip:${ip}`, deps.rateLimits.auth)) return;
    const parsed = loginBody.safeParse(await readJsonBody(req));
    if (!parsed.success)
      return sendError(res, appError('validation', 'Email and password are required.'));
    // Second bucket per email so credential-stuffing can't hide behind rotating IPs.
    if (
      await limited(
        deps,
        res,
        `rate:api:auth:email:${parsed.data.email.toLowerCase()}`,
        deps.rateLimits.auth,
      )
    ) {
      return;
    }
    return sendResult(res, await deps.auth.login(parsed.data));
  }

  // ---- everything below requires a session ----
  const token = bearerToken(req);
  const principal = token === null ? null : await deps.auth.authenticate(token);
  if (principal === null) return sendError(res, appError('unauthorized', 'Sign in required.'));
  // Per-creator throttle over the whole authenticated surface (incl. uploads).
  if (
    await limited(
      deps,
      res,
      `rate:api:creator:${principal.creatorId}`,
      deps.rateLimits.authenticated,
    )
  )
    return;

  if (method === 'POST' && path === '/api/auth/logout') {
    if (token !== null) await deps.auth.logout(token);
    res.writeHead(204).end();
    return;
  }
  if (method === 'GET' && path === '/api/me') {
    const creator = await deps.creators.getById(principal.creatorId);
    return creator.ok
      ? sendJson(res, 200, { creator: creator.value, email: principal.email })
      : sendError(res, creator.error);
  }
  if (method === 'GET' && path === '/api/profile') {
    return sendResult(res, await deps.creators.getById(principal.creatorId));
  }
  if (method === 'PATCH' && path === '/api/profile') {
    const body = (await readJsonBody(req)) as ProfilePatchInput;
    return sendResult(res, await deps.creators.updateProfile(principal.creatorId, body));
  }
  if (method === 'GET' && path === '/api/content/drops') {
    return sendJson(res, 200, await deps.drops.listByCreator(principal.creatorId));
  }
  if (method === 'POST' && path === '/api/content/drops') {
    const parsed = createDropBody.safeParse(await readJsonBody(req));
    if (!parsed.success)
      return sendError(res, appError('validation', 'Please check the drop fields.'));
    return sendResult(
      res,
      await deps.drops.createDrop({ creatorId: principal.creatorId, ...parsed.data }),
      201,
    );
  }
  if (method === 'GET' && path === '/api/plans') {
    return sendJson(res, 200, await deps.subscriptions.listPlans(principal.creatorId));
  }
  if (method === 'POST' && path === '/api/plans') {
    const parsed = createPlanBody.safeParse(await readJsonBody(req));
    if (!parsed.success)
      return sendError(res, appError('validation', 'Please check the plan fields.'));
    return sendResult(
      res,
      await deps.subscriptions.createPlan({ creatorId: principal.creatorId, ...parsed.data }),
      201,
    );
  }
  if (method === 'GET' && path === '/api/analytics/summary') {
    return sendJson(res, 200, await deps.analytics.creatorSummary(principal.creatorId));
  }
  if (method === 'GET' && path === '/api/onboarding') {
    return sendResult(res, await deps.onboarding.getState(principal.creatorId));
  }
  if (method === 'POST' && path === '/api/onboarding/complete') {
    return sendResult(res, await deps.onboarding.complete(principal.creatorId));
  }

  const publish = method === 'POST' ? PUBLISH_RE.exec(path) : null;
  if (publish) {
    return sendResult(res, await deps.drops.publishDrop(principal.creatorId, publish[1] ?? ''));
  }
  const asset = method === 'POST' ? ASSETS_RE.exec(path) : null;
  if (asset) return uploadAsset(deps, principal, asset[1] ?? '', req, res);

  sendError(res, appError('not_found', 'Not found.'));
};

/** Upload media to a drop: verify ownership → store bytes (ContentProvider) → record asset. */
const uploadAsset = async (
  deps: ApiDependencies,
  principal: AuthPrincipal,
  dropId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> => {
  const owned = await deps.drops.getOwnedDrop(principal.creatorId, dropId);
  if (!owned.ok) return sendError(res, owned.error); // never store bytes for a drop you don't own

  const assetType = uploadableType.safeParse(header(req, 'x-asset-type'));
  if (!assetType.success) {
    return sendError(
      res,
      appError('validation', 'x-asset-type must be photo, video, or document.'),
    );
  }
  const mimeType = header(req, 'content-type') ?? 'application/octet-stream';
  const fileName = header(req, 'x-file-name') ?? `${randomUUID()}`;
  const position = Number(header(req, 'x-position') ?? '0');
  const bytes = await readRawBody(req);
  if (bytes.length === 0) return sendError(res, appError('validation', 'Empty upload.'));

  const stored = await deps.content.store({
    creatorId: principal.creatorId,
    dropId,
    fileName,
    mimeType,
    bytes,
  });
  if (!stored.ok) return sendError(res, stored.error);

  const contentType: ContentType = assetType.data;
  const asset = await deps.drops.addAsset({
    creatorId: principal.creatorId,
    dropId,
    position: Number.isInteger(position) ? position : 0,
    contentType,
    storageBucket: stored.value.bucket,
    storagePath: stored.value.path,
    mimeType,
    fileSizeBytes: BigInt(stored.value.sizeBytes),
  });
  sendResult(res, asset, 201);
};

const header = (req: IncomingMessage, name: string): string | null => {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
};
