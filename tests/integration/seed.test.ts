/** Seed is idempotent: two runs leave identical state and never clobber edits. */
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { runSeed, SEED_IDS } from '../../src/adapters/persistence/db/seed.js';
import { systemSettings } from '../../src/adapters/persistence/db/schema/index.js';
import { eq } from 'drizzle-orm';
import { connect } from './helpers.js';

const ctx = connect();
afterAll(() => ctx.db.close());

const countAll = async (): Promise<Record<string, number>> => {
  const tables = [
    'users',
    'creators',
    'subscription_plans',
    'drops',
    'drop_assets',
    'system_settings',
    'bot_settings',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const rows = await ctx.db.db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`,
    );
    counts[table] = (rows[0] as { n: number }).n;
  }
  return counts;
};

describe('runSeed', () => {
  it('creates creator, Premium plan, three drops (all access types), and settings; re-run is a no-op', async () => {
    await runSeed(ctx.db.db);
    const afterFirst = await countAll();

    const dropFree = await ctx.repos.drops.findById(SEED_IDS.dropFree);
    const dropPremium = await ctx.repos.drops.findById(SEED_IDS.dropPremium);
    const dropUnlock = await ctx.repos.drops.findById(SEED_IDS.dropUnlock);
    expect(dropFree?.accessType).toBe('free');
    expect(dropPremium?.accessType).toBe('premium');
    expect(dropUnlock?.accessType).toBe('pay_per_unlock');
    expect(dropUnlock?.priceStars).toBe(50);

    const plan = await ctx.repos.plans.findByCreatorAndName(SEED_IDS.creator, 'Premium');
    expect(plan?.durationDays).toBe(30);

    expect((await ctx.repos.settings.getSystem('maintenance_mode'))?.value).toBe(false);
    expect((await ctx.repos.settings.getSystem('payments.mock_enabled'))?.value).toBe(true);

    await runSeed(ctx.db.db);
    expect(await countAll()).toEqual(afterFirst);
  });

  it('never clobbers manual edits on re-run', async () => {
    await runSeed(ctx.db.db);
    await ctx.db.db
      .update(systemSettings)
      .set({ value: true })
      .where(eq(systemSettings.key, 'maintenance_mode'));

    await runSeed(ctx.db.db);
    expect((await ctx.repos.settings.getSystem('maintenance_mode'))?.value).toBe(true);

    // restore for other suites
    await ctx.db.db
      .update(systemSettings)
      .set({ value: false })
      .where(eq(systemSettings.key, 'maintenance_mode'));
  });
});
