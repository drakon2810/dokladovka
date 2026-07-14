import type { Role } from '../data/types';

/**
 * Explicit service-layer permissions for the three legacy demo roles.
 *
 * The role comes from the authenticated session in production. Keeping the
 * mapping here (instead of scattered negative role checks) makes a future,
 * malformed or not-yet-supported role fail closed by default.
 */
export const CAPABILITIES = [
  'tenant.read',
  'profile.update',
  'organization.manage',
  'bank-account.manage',
  'queue.manage',
  'alias.manage',
  'document.create',
  'document.edit',
  'document.payment.manage',
  'document.payment-qr.generate',
  'document.approve',
  'document.reject',
  'document.workflow.manage',
  'document.reprocess',
  'document.comment',
  'code-list.manage',
  'user.manage',
  'export.manage',
  'inbound.simulate',
  'inbound.assign',
  'demo.reset',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ACCOUNTANT_CAPABILITIES = [
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
] as const satisfies readonly Capability[];

const APPROVER_CAPABILITIES = [
  'tenant.read',
  'profile.update',
  'document.approve',
  'document.reject',
  'document.comment',
] as const satisfies readonly Capability[];

export const CAPABILITIES_BY_ROLE = Object.freeze({
  admin: Object.freeze([...CAPABILITIES]),
  uctovnik: Object.freeze([...ACCOUNTANT_CAPABILITIES]),
  schvalovatel: Object.freeze([...APPROVER_CAPABILITIES]),
}) satisfies Readonly<Record<Role, readonly Capability[]>>;

export function isKnownRole(role: unknown): role is Role {
  return role === 'admin' || role === 'uctovnik' || role === 'schvalovatel';
}

export function hasCapability(role: unknown, capability: Capability): boolean {
  if (!isKnownRole(role)) return false;
  return (CAPABILITIES_BY_ROLE[role] as readonly Capability[]).includes(capability);
}

export function assertCapability(
  role: unknown,
  capability: Capability,
  message = 'Na túto operáciu nemáte oprávnenie',
): asserts role is Role {
  if (!hasCapability(role, capability)) throw new Error(message);
}
