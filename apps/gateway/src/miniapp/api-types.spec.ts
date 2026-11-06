import { PERMISSIONS as STORE_PERMISSIONS } from '@cod2admin/admin-store';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from './api-types.js';

describe('PERMISSIONS', () => {
  it('deep-equals the admin-store catalog', () => {
    expect(PERMISSIONS).toEqual(STORE_PERMISSIONS);
  });
});
