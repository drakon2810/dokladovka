// Testy životného cyklu aliasov cez servisnú vrstvu — DoD §13.1–§13.4.
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createOrganization,
  disableAlias,
  listAliases,
  listQueues,
  regenerateAlias,
  resetDemoData,
  setRole,
  updateOrganization,
} from './api';
import { storeApi } from './store';

const ORG_INPUT = {
  nazov: 'AGS s.r.o.',
  ico: '12345678',
  dic: '2020123456',
  icDph: 'SK2020123456',
  farba: '#0E7A5F',
};

beforeEach(async () => {
  await setRole('admin');
  await resetDemoData();
  await setRole('admin');
});

describe('vytvorenie organizácie (DoD §13.1, §13.2)', () => {
  it('vráti adresu tvaru ags-xxxxxx@doklady.dokladorpro.sk', async () => {
    const res = await createOrganization(ORG_INPUT);
    expect(res.primaryEmailAlias.address).toMatch(
      /^ags-[a-z2-9]{6}@doklady\.dokladorpro\.sk$/,
    );
    expect(res.organization.emailAlias).toBe(res.primaryEmailAlias.address);
    expect(res.primaryEmailAlias.status).toBe('active');
    expect(res.primaryEmailAlias.isPrimary).toBe(true);
  });

  it('adresa je unikátna aj pri rovnakom názve organizácie', async () => {
    const a = await createOrganization(ORG_INPUT);
    const b = await createOrganization(ORG_INPUT);
    expect(a.primaryEmailAlias.address).not.toBe(b.primaryEmailAlias.address);
  });

  it('odmietne nevalidný vstup (IČO musí mať 8 číslic)', async () => {
    await expect(createOrganization({ ...ORG_INPUT, ico: '123' })).rejects.toThrow();
  });

  it('vytvorenie organizácie je povolené iba adminovi', async () => {
    await setRole('uctovnik');
    await expect(createOrganization(ORG_INPUT)).rejects.toThrow(/admin/);
  });
});

describe('premenovanie organizácie (DoD §13.3)', () => {
  it('nemení už vydaný alias', async () => {
    const { organization, primaryEmailAlias } = await createOrganization(ORG_INPUT);
    await updateOrganization(organization.id, { nazov: 'Úplne Iné Meno a.s.' });
    const org = storeApi.get().organizations.find((o) => o.id === organization.id)!;
    expect(org.nazov).toBe('Úplne Iné Meno a.s.');
    expect(org.emailAlias).toBe(primaryEmailAlias.address);
    const aliases = await listAliases(organization.id);
    expect(aliases).toHaveLength(3);
    expect(aliases.find((alias) => alias.isPrimary)?.address).toBe(
      primaryEmailAlias.address,
    );
  });
});

describe('regenerácia aliasu (DoD §13.4)', () => {
  it('vytvorí nový primárny alias a starý prejde do grace_period', async () => {
    await setRole('admin');
    const { organization, primaryEmailAlias } = await createOrganization(ORG_INPUT);
    const beforeQueues = await listQueues(organization.id);
    const secondaryAliasesBefore = (await listAliases(organization.id)).filter(
      (alias) => !alias.isPrimary,
    );
    const nový = await regenerateAlias(organization.id);

    expect(nový.address).not.toBe(primaryEmailAlias.address);
    expect(nový.isPrimary).toBe(true);
    expect(nový.status).toBe('active');

    const aliases = await listAliases(organization.id);
    const starý = aliases.find((a) => a.id === primaryEmailAlias.id)!;
    expect(starý.status).toBe('grace_period');
    expect(starý.isPrimary).toBe(false);
    expect(starý.graceUntil).toBeTruthy();

    const org = storeApi.get().organizations.find((o) => o.id === organization.id)!;
    expect(org.emailAlias).toBe(nový.address);

    const afterQueues = await listQueues(organization.id);
    const aliasesAfter = await listAliases(organization.id);
    const receivedQueue = afterQueues.find((queue) => queue.kind === 'received_invoices');
    expect(receivedQueue?.importAlias).toBe(nový.address);
    for (const secondary of secondaryAliasesBefore) {
      expect(aliasesAfter.find((alias) => alias.id === secondary.id)).toMatchObject({
        status: 'active',
        isPrimary: false,
        address: secondary.address,
      });
      expect(afterQueues.find((queue) => queue.id === secondary.queueId)?.importAlias).toBe(
        secondary.address,
      );
      expect(beforeQueues.find((queue) => queue.id === secondary.queueId)?.importAlias).toBe(
        secondary.address,
      );
    }
  });

  it('regeneráciu smie vykonať iba admin', async () => {
    await setRole('admin');
    const { organization } = await createOrganization(ORG_INPUT);
    await setRole('uctovnik');
    await expect(regenerateAlias(organization.id)).rejects.toThrow(/admin/);
  });

  it('admin môže vypnúť neprimárny alias a adresa sa zachová v histórii', async () => {
    await setRole('admin');
    const { organization, primaryEmailAlias } = await createOrganization(ORG_INPUT);
    await regenerateAlias(organization.id);
    await disableAlias(primaryEmailAlias.id);

    const aliases = await listAliases(organization.id);
    const disabled = aliases.find((alias) => alias.id === primaryEmailAlias.id);
    expect(disabled?.status).toBe('disabled');
    expect(disabled?.disabledAt).toBeTruthy();
    expect(disabled?.address).toBe(primaryEmailAlias.address);
  });

  it('uplynuté grace obdobie sa pri načítaní zmení na disabled', async () => {
    await setRole('admin');
    const { organization, primaryEmailAlias } = await createOrganization(ORG_INPUT);
    await regenerateAlias(organization.id);
    storeApi.set({
      aliases: storeApi.get().aliases.map((alias) =>
        alias.id === primaryEmailAlias.id
          ? { ...alias, graceUntil: '2000-01-01T00:00:00.000Z' }
          : alias,
      ),
    });

    const aliases = await listAliases(organization.id);
    expect(aliases.find((alias) => alias.id === primaryEmailAlias.id)?.status).toBe(
      'disabled',
    );
  });
});
