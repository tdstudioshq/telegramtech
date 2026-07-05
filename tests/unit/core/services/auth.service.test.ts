/**
 * AuthService (M7.1) — register/login/authenticate/logout with deterministic auth
 * fakes. Verifies creator+identity creation, no user enumeration, session validity,
 * expiry (FakeClock, no sleeps), and logout.
 */
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../../../src/core/services/auth.service.js';
import { FakePasswordHasher, FakeSessionTokenService } from '../../../fakes/fake-auth.js';
import { createWorld } from '../../../fakes/world.js';

const TTL_HOURS = 720;

const setup = () => {
  const world = createWorld();
  const auth = new AuthService(
    world.uow,
    new FakePasswordHasher(),
    new FakeSessionTokenService(),
    world.clock,
    world.audit,
    TTL_HOURS,
  );
  return { world, auth };
};

const creds = { email: 'Ada@Example.com', password: 'correct-horse', displayName: 'Ada' };

describe('AuthService.register', () => {
  it('creates a creator + identity + session and audits the registration', async () => {
    const { world, auth } = setup();
    const result = await auth.register({ ...creds, slug: 'ada' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBeTruthy();
    expect(result.value.creator.status).toBe('active');
    expect(result.value.creator.userId).toBeNull(); // web creator, no Telegram user
    expect(result.value.creator.slug).toBe('ada');
    expect(world.store.state.creatorIdentities[0]?.email).toBe('ada@example.com'); // normalized
    expect(world.store.state.auditLogs.map((e) => e.action)).toContain('creator.registered');
  });

  it('rejects a duplicate email and a taken slug', async () => {
    const { auth } = setup();
    await auth.register({ ...creds, slug: 'ada' });

    const dupEmail = await auth.register({ email: 'ADA@example.com', password: 'another-pass', displayName: 'A2' });
    expect(dupEmail.ok).toBe(false);
    if (!dupEmail.ok) expect(dupEmail.error.code).toBe('conflict');

    const dupSlug = await auth.register({ email: 'other@example.com', password: 'another-pass', displayName: 'O', slug: 'ada' });
    expect(dupSlug.ok).toBe(false);
    if (!dupSlug.ok) expect(dupSlug.error.code).toBe('conflict');
  });

  it('rejects invalid input (short password)', async () => {
    const { auth } = setup();
    const result = await auth.register({ email: 'x@example.com', password: 'short', displayName: 'X' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('validation');
  });
});

describe('AuthService.login', () => {
  it('logs in with correct credentials', async () => {
    const { auth } = setup();
    await auth.register(creds);
    const result = await auth.login({ email: 'ada@example.com', password: 'correct-horse' });
    expect(result.ok).toBe(true);
  });

  it('returns the same generic error for wrong password and unknown email', async () => {
    const { auth } = setup();
    await auth.register(creds);
    const wrong = await auth.login({ email: 'ada@example.com', password: 'nope' });
    const unknown = await auth.login({ email: 'ghost@example.com', password: 'whatever' });
    expect(wrong.ok || unknown.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('unauthorized');
    if (!unknown.ok) expect(unknown.error.code).toBe('unauthorized');
  });
});

describe('AuthService.authenticate / logout', () => {
  it('resolves a valid token to its principal', async () => {
    const { auth } = setup();
    const reg = await auth.register(creds);
    if (!reg.ok) throw new Error('register failed');

    const principal = await auth.authenticate(reg.value.token);
    expect(principal).not.toBeNull();
    expect(principal?.creatorId).toBe(reg.value.creator.id);
    expect(principal?.email).toBe('ada@example.com');
  });

  it('rejects an unknown token, an expired session, and a logged-out token', async () => {
    const { world, auth } = setup();
    const reg = await auth.register(creds);
    if (!reg.ok) throw new Error('register failed');

    expect(await auth.authenticate('bogus')).toBeNull();

    const login = await auth.login({ email: 'ada@example.com', password: 'correct-horse' });
    if (!login.ok) throw new Error('login failed');
    world.clock.advanceMs((TTL_HOURS + 1) * 3_600_000);
    expect(await auth.authenticate(login.value.token)).toBeNull(); // expired

    // fresh session, then logout invalidates it
    world.clock.set(new Date('2026-02-01T00:00:00Z'));
    const fresh = await auth.login({ email: 'ada@example.com', password: 'correct-horse' });
    if (!fresh.ok) throw new Error('login failed');
    expect(await auth.authenticate(fresh.value.token)).not.toBeNull();
    await auth.logout(fresh.value.token);
    expect(await auth.authenticate(fresh.value.token)).toBeNull();
  });
});
