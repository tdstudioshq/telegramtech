/**
 * ContentProvider port (ADR-006) — store/retrieve/delete content, storage-agnostic.
 * MVP implementation: SupabaseStorageProvider (private bucket, tenant-prefixed
 * paths, short-lived signed URLs). Core never knows where bytes live.
 */
import type { AppError } from '../../shared/app-error.js';
import type { Result } from '../../shared/result.js';
import type { CreatorId, DropId } from '../../shared/domain.js';

export interface StoreContentInput {
  readonly creatorId: CreatorId;
  readonly dropId: DropId;
  /** Object name within the drop prefix, e.g. `<uuid>.jpg`. */
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface StoredObject {
  readonly bucket: string;
  /** `creators/{creatorId}/drops/{dropId}/{fileName}` (SYSTEM_ARCHITECTURE §8). */
  readonly path: string;
  readonly sizeBytes: number;
}

/** Short-lived signed URL — content moves only via these, generated server-side (§13). */
export interface Deliverable {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface ContentProvider {
  store(input: StoreContentInput): Promise<Result<StoredObject, AppError>>;
  getDeliverable(bucket: string, path: string): Promise<Result<Deliverable, AppError>>;
  delete(bucket: string, path: string): Promise<Result<void, AppError>>;
  exists(bucket: string, path: string): Promise<boolean>;
}
