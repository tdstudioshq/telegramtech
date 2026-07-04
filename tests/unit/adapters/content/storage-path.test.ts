import { describe, expect, it } from 'vitest';
import { buildStoragePath } from '../../../../src/adapters/content/supabase-storage.provider.js';

describe('buildStoragePath', () => {
  it('follows the tenant-prefixed convention (§8): creators/{creatorId}/drops/{dropId}/{file}', () => {
    expect(buildStoragePath('c-1', 'd-1', 'photo.jpg')).toBe('creators/c-1/drops/d-1/photo.jpg');
  });
});
