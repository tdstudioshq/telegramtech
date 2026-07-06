/**
 * M7.3.1: the marketplace/sweep indexes and pg_trgm extension the ROADMAP claimed
 * but never shipped now exist, and discovery search still returns the same results.
 */
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { connect } from './helpers.js';

const ctx = connect();
afterAll(() => ctx.db.close());

const indexNames = async (table: string): Promise<string[]> => {
  const rows = await ctx.db.db.execute(
    sql`select indexname from pg_indexes where tablename = ${table}`,
  );
  return (rows as unknown as { indexname: string }[]).map((r) => r.indexname);
};

describe('marketplace indexes (M7.3.1)', () => {
  it('creates the discovery, search, and sweep indexes plus the pg_trgm extension', async () => {
    const creatorIdx = await indexNames('creators');
    expect(creatorIdx).toEqual(
      expect.arrayContaining([
        'creators_discoverable_idx',
        'creators_category_idx',
        'creators_display_name_trgm_idx',
        'creators_slug_trgm_idx',
      ]),
    );

    const paymentIdx = await indexNames('payments');
    expect(paymentIdx).toContain('payments_stale_pending_idx');

    const ext = await ctx.db.db.execute(
      sql`select extname from pg_extension where extname = 'pg_trgm'`,
    );
    expect((ext as unknown as { extname: string }[]).map((r) => r.extname)).toContain('pg_trgm');
  });

  it('discovery search returns the matching creator and excludes non-matches (contract preserved)', async () => {
    const tag = `mktidx${Date.now()}`;
    const alpha = await ctx.repos.creators.create({
      displayName: `${tag} Alpha`,
      slug: `${tag}-alpha`,
      onboardingCompletedAt: new Date(),
      status: 'active',
    });
    const beta = await ctx.repos.creators.create({
      displayName: `${tag} Beta`,
      slug: `${tag}-beta`,
      onboardingCompletedAt: new Date(),
      status: 'active',
    });

    const results = await ctx.repos.creators.listDiscoverable({
      query: `${tag} Alph`,
      limit: 50,
      offset: 0,
    });
    const ids = results.map((c) => c.id);
    expect(ids).toContain(alpha.id);
    expect(ids).not.toContain(beta.id);
  });
});
