/**
 * Fakes for the content ports: an in-memory ContentProvider and a recording,
 * scriptable ContentTransport.
 */
import type {
  ContentProvider,
  Deliverable,
  StoreContentInput,
  StoredObject,
} from '../../src/core/ports/content-provider.port.js';
import type {
  ContentTransport,
  SendOptions,
  TransportContent,
} from '../../src/core/ports/content-transport.port.js';
import type { User } from '../../src/shared/entities.js';
import { appError, type AppError } from '../../src/shared/app-error.js';
import { err, ok, type Result } from '../../src/shared/result.js';
import { FakeClock } from './fake-clock.js';

export class FakeContentProvider implements ContentProvider {
  readonly objects = new Map<string, Uint8Array>();

  constructor(
    private readonly clock: FakeClock = new FakeClock(),
    private readonly bucket = 'drops',
  ) {}

  /** Test setup helper: make a path resolvable without going through store(). */
  putObject(bucket: string, path: string, bytes: Uint8Array = new Uint8Array([1])): void {
    this.objects.set(`${bucket}/${path}`, bytes);
  }

  async store(input: StoreContentInput): Promise<Result<StoredObject, AppError>> {
    const path = `creators/${input.creatorId}/drops/${input.dropId}/${input.fileName}`;
    this.objects.set(`${this.bucket}/${path}`, input.bytes);
    return ok({ bucket: this.bucket, path, sizeBytes: input.bytes.byteLength });
  }

  async getDeliverable(bucket: string, path: string): Promise<Result<Deliverable, AppError>> {
    if (!this.objects.has(`${bucket}/${path}`)) {
      return err(appError('not_found', 'Content is temporarily unavailable.', { bucket, path }));
    }
    return ok({
      url: `signed://${bucket}/${path}`,
      expiresAt: new Date(this.clock.now().getTime() + 120_000),
    });
  }

  async delete(bucket: string, path: string): Promise<Result<void, AppError>> {
    this.objects.delete(`${bucket}/${path}`);
    return ok(undefined);
  }

  async exists(bucket: string, path: string): Promise<boolean> {
    return this.objects.has(`${bucket}/${path}`);
  }
}

export interface RecordedSend {
  readonly user: User;
  readonly content: TransportContent;
  readonly options: SendOptions;
}

export class FakeContentTransport implements ContentTransport {
  readonly sends: RecordedSend[] = [];
  private failuresRemaining = 0;

  failNextSends(count: number): void {
    this.failuresRemaining = count;
  }

  async send(
    user: User,
    content: TransportContent,
    options: SendOptions,
  ): Promise<Result<void, AppError>> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return err(appError('internal', 'Delivery failed.', { transport: 'fake' }));
    }
    this.sends.push({ user, content, options });
    return ok(undefined);
  }
}
