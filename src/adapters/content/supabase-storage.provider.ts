/**
 * SupabaseStorageProvider (ADR-006, Q1) — content source of truth. Private
 * bucket; bytes move only via short-lived signed URLs generated server-side
 * (§13). This adapter is the ONLY place @supabase/supabase-js exists (ADR-001)
 * and the only consumer of the service-role key.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Clock } from '../../core/ports/clock.port.js';
import type {
  ContentProvider,
  Deliverable,
  StoreContentInput,
  StoredObject,
} from '../../core/ports/content-provider.port.js';
import { appError, type AppError } from '../../shared/app-error.js';
import { err, ok, type Result } from '../../shared/result.js';
import type { CreatorId, DropId } from '../../shared/domain.js';

export interface SupabaseStorageConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
  /** Default bucket for new uploads (STORAGE_BUCKET). */
  readonly bucket: string;
  readonly signedUrlTtlSeconds: number;
}

/** Tenant-prefixed path convention (§8): creators/{creatorId}/drops/{dropId}/{file}. */
export const buildStoragePath = (creatorId: CreatorId, dropId: DropId, fileName: string): string =>
  `creators/${creatorId}/drops/${dropId}/${fileName}`;

const systemClock: Clock = { now: () => new Date() };

export class SupabaseStorageProvider implements ContentProvider {
  private readonly client: SupabaseClient;

  constructor(
    private readonly config: SupabaseStorageConfig,
    private readonly clock: Clock = systemClock,
  ) {
    this.client = createClient(config.url, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async store(input: StoreContentInput): Promise<Result<StoredObject, AppError>> {
    const path = buildStoragePath(input.creatorId, input.dropId, input.fileName);
    const { error } = await this.client.storage
      .from(this.config.bucket)
      .upload(path, input.bytes, { contentType: input.mimeType, upsert: false });
    if (error !== null) {
      return err(
        appError('internal', 'Content upload failed.', { path, cause: error.message }),
      );
    }
    return ok({ bucket: this.config.bucket, path, sizeBytes: input.bytes.byteLength });
  }

  async getDeliverable(bucket: string, path: string): Promise<Result<Deliverable, AppError>> {
    const ttl = this.config.signedUrlTtlSeconds;
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(path, ttl);
    if (error !== null || data === null) {
      return err(
        appError('not_found', 'Content is temporarily unavailable.', {
          bucket,
          path,
          cause: error?.message,
        }),
      );
    }
    return ok({
      url: data.signedUrl,
      expiresAt: new Date(this.clock.now().getTime() + ttl * 1000),
    });
  }

  async delete(bucket: string, path: string): Promise<Result<void, AppError>> {
    const { error } = await this.client.storage.from(bucket).remove([path]);
    if (error !== null) {
      return err(appError('internal', 'Content deletion failed.', { bucket, path, cause: error.message }));
    }
    return ok(undefined);
  }

  async exists(bucket: string, path: string): Promise<boolean> {
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash === -1 ? '' : path.slice(0, lastSlash);
    const name = lastSlash === -1 ? path : path.slice(lastSlash + 1);
    const { data, error } = await this.client.storage
      .from(bucket)
      .list(dir, { limit: 1, search: name });
    if (error !== null || data === null) return false;
    return data.some((object) => object.name === name);
  }
}
