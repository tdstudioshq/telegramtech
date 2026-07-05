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
import type { ContentProvider } from '../../core/ports/content-provider.port.js';
import type { AnalyticsService } from '../../core/services/analytics.service.js';
import type { AuthPrincipal, AuthService, RegisterInput } from '../../core/services/auth.service.js';
import type { CreatorService, ProfilePatchInput } from '../../core/services/creator.service.js';
import type { DropService } from '../../core/services/drop.service.js';
import type { SubscriptionService } from '../../core/services/subscription.service.js';
import type { Logger } from '../../logging/logger.js';
import { appError } from '../../shared/app-error.js';
import { ACCESS_TYPES, CONTENT_TYPES, type ContentType } from '../../shared/domain.js';
import type { HttpRequestHandler } from '../../server/http-server.js';
import { bearerToken, readJsonBody, readRawBody, sendError, sendJson, sendResult } from './http.js';

export interface ApiDependencies {
  readonly auth: AuthService;
  readonly creators: CreatorService;
  readonly drops: DropService;
  readonly subscriptions: SubscriptionService;
  readonly analytics: AnalyticsService;
  readonly content: ContentProvider;
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

  // ---- public routes ----
  if (method === 'POST' && path === '/api/auth/register') {
    const body = (await readJsonBody(req)) as RegisterInput;
    return sendResult(res, await deps.auth.register(body), 201);
  }
  if (method === 'POST' && path === '/api/auth/login') {
    const parsed = loginBody.safeParse(await readJsonBody(req));
    if (!parsed.success) return sendError(res, appError('validation', 'Email and password are required.'));
    return sendResult(res, await deps.auth.login(parsed.data));
  }

  // ---- everything below requires a session ----
  const token = bearerToken(req);
  const principal = token === null ? null : await deps.auth.authenticate(token);
  if (principal === null) return sendError(res, appError('unauthorized', 'Sign in required.'));

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
    if (!parsed.success) return sendError(res, appError('validation', 'Please check the drop fields.'));
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
    if (!parsed.success) return sendError(res, appError('validation', 'Please check the plan fields.'));
    return sendResult(
      res,
      await deps.subscriptions.createPlan({ creatorId: principal.creatorId, ...parsed.data }),
      201,
    );
  }
  if (method === 'GET' && path === '/api/analytics/summary') {
    return sendJson(res, 200, await deps.analytics.creatorSummary(principal.creatorId));
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
    return sendError(res, appError('validation', 'x-asset-type must be photo, video, or document.'));
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
