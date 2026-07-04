import { describe, expect, it } from 'vitest';
import { UserService } from '../../../../src/core/services/user.service.js';
import { createWorld } from '../../../fakes/world.js';

describe('UserService.ensureRegistered', () => {
  it('creates once and audits user.registered as a platform-level event', async () => {
    const world = createWorld();
    const service = new UserService(world.uow, world.audit);

    const user = await service.ensureRegistered({ telegramId: 42n, username: 'tyler' });

    expect(user.username).toBe('tyler');
    const entry = world.store.state.auditLogs[0];
    expect(entry?.action).toBe('user.registered');
    expect(entry?.creatorId).toBeNull();
    expect(entry?.actorUserId).toBe(user.id);
  });

  it('is idempotent — the second call returns the same user, no second audit row', async () => {
    const world = createWorld();
    const service = new UserService(world.uow, world.audit);

    const first = await service.ensureRegistered({ telegramId: 42n });
    const second = await service.ensureRegistered({ telegramId: 42n, username: 'later' });

    expect(second.id).toBe(first.id);
    expect(world.store.state.users).toHaveLength(1);
    expect(world.store.state.auditLogs).toHaveLength(1);
  });
});

describe('AuditService vocabulary enforcement', () => {
  it('rejects actions outside the typed vocabulary (a bad entry is a bug → throws)', async () => {
    const world = createWorld();

    await expect(
      world.uow.run(async (repos) =>
        world.audit.record(repos, {
          creatorId: null,
          // @ts-expect-error — deliberately off-vocabulary
          action: 'made.up.verb',
          entityType: 'user',
          entityId: '00000000-0000-4000-8000-000000000001',
          actorType: 'system',
        }),
      ),
    ).rejects.toThrow();
  });

  it('enforces the actor CHECK: user actions name the user, system/job never do', async () => {
    const world = createWorld();
    const entityId = '00000000-0000-4000-8000-000000000001';

    await expect(
      world.uow.run(async (repos) =>
        world.audit.record(repos, {
          creatorId: null,
          action: 'user.registered',
          entityType: 'user',
          entityId,
          actorType: 'user', // user actor without actorUserId → violates the CHECK mirror
        }),
      ),
    ).rejects.toThrow();

    await expect(
      world.uow.run(async (repos) =>
        world.audit.record(repos, {
          creatorId: null,
          action: 'subscription.expired',
          entityType: 'subscription',
          entityId,
          actorType: 'job',
          actorUserId: entityId, // job actor naming a user → also violates
        }),
      ),
    ).rejects.toThrow();
  });

  it('audit rows die with a rolled-back transaction (in-transaction, not event-driven)', async () => {
    const world = createWorld();

    await expect(
      world.uow.run(async (repos) => {
        await world.audit.record(repos, {
          creatorId: null,
          action: 'user.registered',
          entityType: 'user',
          entityId: '00000000-0000-4000-8000-000000000001',
          actorType: 'system',
        });
        throw new Error('boom — rollback');
      }),
    ).rejects.toThrow('boom');

    expect(world.store.state.auditLogs).toHaveLength(0);
  });
});
