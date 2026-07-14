import { describe, expect, it } from 'vitest';
import {
  assertCapability,
  CAPABILITIES,
  CAPABILITIES_BY_ROLE,
  hasCapability,
  type Capability,
} from './access';
import type { Role } from '../data/types';

const expected: Record<Role, readonly Capability[]> = {
  admin: CAPABILITIES,
  uctovnik: [
    'tenant.read',
    'profile.update',
    'document.create',
    'document.edit',
    'document.payment.manage',
    'document.payment-qr.generate',
    'document.approve',
    'document.reject',
    'document.workflow.manage',
    'document.reprocess',
    'document.comment',
    'export.manage',
  ],
  schvalovatel: [
    'tenant.read',
    'profile.update',
    'document.approve',
    'document.reject',
    'document.comment',
  ],
};

describe('capability allow-list', () => {
  it.each(Object.entries(expected) as Array<[Role, readonly Capability[]]>) (
    '%s dostane iba explicitne povolené capability',
    (role, allowed) => {
      for (const capability of CAPABILITIES) {
        expect(hasCapability(role, capability), `${role}: ${capability}`).toBe(
          allowed.includes(capability),
        );
      }
      expect(CAPABILITIES_BY_ROLE[role]).toEqual(allowed);
    },
  );

  it.each(['owner', 'reader', '', null, undefined, { role: 'admin' }])(
    'neznáma alebo poškodená rola %j zlyhá uzavreto',
    (role) => {
      expect(hasCapability(role, 'tenant.read')).toBe(false);
      expect(() => assertCapability(role, 'document.comment')).toThrow(/oprávnenie/);
    },
  );

  it('assertCapability môže vrátiť doménovú chybovú správu', () => {
    expect(() =>
      assertCapability('schvalovatel', 'document.edit', 'Schvaľovateľ nemôže upravovať'),
    ).toThrow('Schvaľovateľ nemôže upravovať');
  });
});
