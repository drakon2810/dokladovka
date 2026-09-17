import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { requireBrowserAuth, requireCsrf, requireOrganizationAccess, requireRole } from '../auth.js';
import type { Database } from '../db/database.js';
import { aktualizujProfil, nacitajProfil, odpovedzOtazke, ulozFakt } from '../services/profilService.js';
import { prepocitajPraxBanky, rozhodniPraxBanky } from '../services/bankaPraxService.js';
import { zamkniPrax } from '../services/uctoProfileService.js';

// Profil klienta: fakty firmy a otázky účtovníkovi. Odpovedá ten, kto účtuje
// (admin aj účtovník); schvaľovateľ profil nevidí.

const orgSchema = z.object({ organizationId: z.string().uuid() });

const odpovedSchema = z.discriminatedUnion('akcia', [
  z.object({ akcia: z.literal('variant'), index: z.number().int().min(0) }).strict(),
  z.object({ akcia: z.literal('ine'), text: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ akcia: z.literal('neskor') }).strict(),
]);

const bankaSchema = z.discriminatedUnion('stav', [
  z.object({ stav: z.literal('potvrdene'), predkontaciaKod: z.string().trim().min(1).max(100) }).strict(),
  z.object({ stav: z.literal('zamietnute') }).strict(),
]);

export function registerProfilRoutes(app: FastifyInstance, database: Database): void {
  const pristup = async (request: Parameters<typeof requireBrowserAuth>[0], write: boolean) => {
    const auth = await requireBrowserAuth(request, database);
    if (write) requireCsrf(request, auth);
    requireRole(auth, ['admin', 'uctovnik']);
    const { organizationId } = orgSchema.parse(request.params);
    await requireOrganizationAccess(database, auth, organizationId);
    return { auth, firma: { tenantId: auth.tenantId, organizationId } };
  };

  app.get('/api/organizations/:organizationId/profil', async (request) => {
    const { firma } = await pristup(request, false);
    return nacitajProfil(database, firma);
  });

  app.put('/api/organizations/:organizationId/profil/fakty/:kluc', async (request) => {
    const { auth, firma } = await pristup(request, true);
    const { kluc } = z.object({ kluc: z.string().min(1).max(100) }).parse(request.params);
    const telo = z.object({ stav: z.enum(['potvrdene', 'nepouziva_sa']), hodnota: z.unknown().optional() }).strict().parse(request.body);
    await database.transaction(async (tx) => {
      // Rovnaký zámok ako generátor: inak by prepočet, ktorý si fakty načítal
      // pred týmto zápisom, potvrdenú odpoveď prepísal späť na návrh.
      await zamkniPrax(tx, firma);
      const hodnota = await ulozFakt(tx, { ...firma, userId: auth.userId }, kluc, telo);
      await writeAudit(tx, {
        tenantId: auth.tenantId, organizationId: firma.organizationId, actorType: 'user', actorId: auth.userId,
        action: 'profil.fakt_ulozeny', entityType: 'organization', entityId: firma.organizationId, correlationId: request.id,
        metadata: { kluc, stav: telo.stav, hodnota },
      });
    });
    return nacitajProfil(database, firma);
  });

  app.post('/api/organizations/:organizationId/profil/otazky/:otazkaId', async (request) => {
    const { auth, firma } = await pristup(request, true);
    const { otazkaId } = z.object({ otazkaId: z.string().uuid() }).parse(request.params);
    const odpoved = odpovedSchema.parse(request.body);
    await database.transaction(async (tx) => {
      await zamkniPrax(tx, firma);
      const metadata = await odpovedzOtazke(tx, { ...firma, userId: auth.userId, correlationId: request.id }, otazkaId, odpoved);
      if (!metadata) return;
      await writeAudit(tx, {
        tenantId: auth.tenantId, organizationId: firma.organizationId, actorType: 'user', actorId: auth.userId,
        action: 'profil.otazka_zodpovedana', entityType: 'profil_otazka', entityId: otazkaId, correlationId: request.id,
        metadata,
      });
    });
    return nacitajProfil(database, firma);
  });

  // Prax banky: potvrdenie jednou z kandidátnych predkontácií alebo zamietnutie.
  app.put('/api/organizations/:organizationId/profil/banka/:praxId', async (request) => {
    const { auth, firma } = await pristup(request, true);
    const { praxId } = z.object({ praxId: z.string().uuid() }).parse(request.params);
    const telo = bankaSchema.parse(request.body);
    await database.transaction(async (tx) => {
      await zamkniPrax(tx, firma);
      const metadata = await rozhodniPraxBanky(tx, { ...firma, userId: auth.userId }, praxId, telo);
      await writeAudit(tx, {
        tenantId: auth.tenantId, organizationId: firma.organizationId, actorType: 'user', actorId: auth.userId,
        action: 'profil.prax_banky', entityType: 'banka_prax', entityId: praxId, correlationId: request.id, metadata,
      });
    });
    return nacitajProfil(database, firma);
  });

  // Ten istý zámok ako prepočet praxe: generátor nesmie bežať nad pravidlami,
  // ktoré prepočet práve vymieňa.
  app.post('/api/organizations/:organizationId/profil/prepocitat', async (request) => {
    const { firma } = await pristup(request, true);
    await database.transaction(async (tx) => {
      await zamkniPrax(tx, firma);
      await aktualizujProfil(tx, firma);
      await prepocitajPraxBanky(tx, firma);
    });
    return nacitajProfil(database, firma);
  });
}
