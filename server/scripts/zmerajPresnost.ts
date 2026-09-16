import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { HttpError } from '../http.js';
import {
  POLIA, intervalSpolahlivosti, presnostNadPrahom, zmerajPresnost, type OknoMerania, type PresnostVysledok, type RezimMerania,
} from '../services/uctoPresnostService.js';

/**
 * Presnosť návrhu zaúčtovania pre všetky firmy naraz. Jedno číslo klame, preto
 * tabuľka po firme, agende a poli a pod ňou mikro (všetky doklady spolu), makro
 * (priemer firiem) a najhoršia firma s intervalom. Nič nezapisuje.
 *
 * Produkcia, len na čítanie — databáza každý pokus o zápis odmietne:
 *   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' api node build/server/scripts/zmerajPresnost.js --rezim bez_ai
 * Voľby: --rezim bez_ai|ai  --okno test|validacia  --vzorka N  --max-volani N  --kategorie  --firma časť_názvu|id
 * Režim ai stojí peniaze a posiela texty dokladov do OpenAI — len so súhlasom.
 * --max-volani je rozpočet CELÉHO behu (predvolene 100), nie na firmu; delí sa
 * rovnomerne a nevyčerpaný zvyšok prejde na ďalšie firmy. S --kategorie volá
 * režim ai aj embeddingy OpenAI; režim bez_ai nikdy.
 */
const { values } = parseArgs({
  options: {
    rezim: { type: 'string', default: 'bez_ai' },
    okno: { type: 'string', default: 'test' },
    vzorka: { type: 'string' },
    'max-volani': { type: 'string' },
    kategorie: { type: 'boolean', default: false },
    firma: { type: 'string' },
  },
});
if (!['bez_ai', 'ai'].includes(values.rezim) || !['test', 'validacia'].includes(values.okno)) {
  throw new Error('Použitie: --rezim bez_ai|ai --okno test|validacia [--vzorka N] [--max-volani N] [--kategorie] [--firma časť_názvu|id]');
}

const config = loadConfig();
const database = await createDatabase(config);
const behy: Array<{ firma: string; vysledok: PresnostVysledok }> = [];
try {
  const firmy = (await database.query<{ id: string; tenant_id: string; name: string } & Record<string, unknown>>(
    `SELECT id, tenant_id, name FROM organizations
      WHERE archived=false AND ($1::text IS NULL OR id=$1 OR name ILIKE '%' || $1 || '%')
      ORDER BY name`,
    [values.firma ?? null],
  )).rows;
  if (firmy.length === 0) throw new Error(`Žiadna firma nezodpovedá „${values.firma}".`);
  const sAi = values.rezim === 'ai';
  let zostatok = values['max-volani'] ? Number(values['max-volani']) : 100;
  if (sAi) console.error(`Režim ai: najviac ${zostatok} volaní modelu spolu pre ${firmy.length} firiem.`);
  for (const [poradie, firma] of firmy.entries()) {
    if (sAi && zostatok <= 0) {
      console.error(`Rozpočet volaní vyčerpaný — ${firmy.length - poradie} firiem sa nemeralo.`);
      break;
    }
    try {
      const vysledok = await zmerajPresnost(database, config, { tenantId: firma.tenant_id, organizationId: firma.id }, {
        rezim: values.rezim as RezimMerania,
        okno: values.okno as OknoMerania,
        vzorka: values.vzorka ? Number(values.vzorka) : undefined,
        // Podiel zo zvyšku rozpočtu; vzorka ho nikdy neprekročí (vyberVzorku).
        maxAiVolani: sAi ? Math.ceil(zostatok / (firmy.length - poradie)) : undefined,
        kategorie: values.kategorie,
      });
      if (sAi) zostatok -= vysledok.vzorka;
      behy.push({ firma: firma.name, vysledok });
    } catch (chyba) {
      // Firma bez dát (409) nesmie zastaviť ostatné.
      if (!(chyba instanceof HttpError)) throw chyba;
      console.error(`${firma.name}: ${chyba.message}`);
    }
  }
} finally {
  await database.close();
}

console.log(JSON.stringify(behy, null, 2));

const podiel = (spravne: number, znamych: number) => (znamych > 0 ? `${((spravne / znamych) * 100).toFixed(1)} %` : '—');
console.log(`\n${'firma'.padEnd(24)} ${'agenda'.padEnd(6)} dokl. ${POLIA.map((pole) => pole.padStart(20)).join('')}  zdržal sa`);
for (const { firma, vysledok } of behy) {
  for (const [agenda, skore] of Object.entries(vysledok.vysledok)) {
    const polia = POLIA.map((pole) => `${skore[pole].spravne}/${skore[pole].znamych} ${podiel(skore[pole].spravne, skore[pole].znamych)}`.padStart(20));
    console.log(`${firma.slice(0, 24).padEnd(24)} ${agenda.padEnd(6)} ${String(skore.dokladov).padStart(5)} ${polia.join('')}  ${skore.zdrzanie}`);
  }
}

console.log('');
for (const pole of POLIA) {
  const firmy = behy.map(({ firma, vysledok }) => {
    const skore = Object.values(vysledok.vysledok).reduce(
      (spolu, agenda) => ({ spravne: spolu.spravne + agenda[pole].spravne, znamych: spolu.znamych + agenda[pole].znamych }),
      { spravne: 0, znamych: 0 },
    );
    return { firma, ...skore, interval: intervalSpolahlivosti(vysledok.doklady, pole) };
  }).filter((firma) => firma.znamych > 0);
  if (firmy.length === 0) continue;
  const mikro = podiel(firmy.reduce((a, f) => a + f.spravne, 0), firmy.reduce((a, f) => a + f.znamych, 0));
  const makro = `${((firmy.reduce((a, f) => a + f.spravne / f.znamych, 0) / firmy.length) * 100).toFixed(1)} %`;
  const najhorsia = firmy.reduce((a, f) => (f.spravne / f.znamych < a.spravne / a.znamych ? f : a));
  const interval = najhorsia.interval
    ? ` (95 % ${(najhorsia.interval[0] * 100).toFixed(1)}–${(najhorsia.interval[1] * 100).toFixed(1)} %)` : '';
  console.log(`${pole.padEnd(12)} mikro ${mikro}  makro ${makro}  najhoršia ${najhorsia.firma} `
    + `${podiel(najhorsia.spravne, najhorsia.znamych)}${interval}`);
}

// Predvyplnenie od istoty 0,9: aká presná je hodnota, ktorú účtovník neotvorí,
// a koľko dokladov sa tak vyplní. Pod 20 dokladmi nad prahom len „málo dokladov".
console.log('\nnad prahom predvyplnenia (istota ≥ 0,9)');
for (const { firma, vysledok } of behy) {
  const polia = POLIA.map((pole) => {
    const nad = presnostNadPrahom(vysledok.doklady, pole);
    const pokrytie = `pokrytie ${(nad.pokrytie * 100).toFixed(0)} %`;
    if (!nad.interval) return `${pole} málo dokladov (${nad.navrhnutych}), ${pokrytie}`;
    return `${pole} ${podiel(nad.spravnych, nad.navrhnutych)} (95 % ${(nad.interval[0] * 100).toFixed(1)}–`
      + `${(nad.interval[1] * 100).toFixed(1)} %), ${pokrytie}`;
  });
  console.log(`${firma.slice(0, 24).padEnd(24)} ${polia.join(' | ')}`);
}

// Nová protistrana: pravidlo ani denník protistrany tu nepomôžu, rozhoduje druh
// plnenia. V celkovom čísle ju prekryjú známi dodávatelia, preto zvlášť.
console.log('\nnová protistrana (firma ju pred dátumom dokladu nemala)');
for (const { firma, vysledok } of behy) {
  const agendy = Object.values(vysledok.vysledokNovaProtistrana);
  const dokladov = agendy.reduce((spolu, skore) => spolu + skore.dokladov, 0);
  if (dokladov === 0) continue;
  const zdrzanie = agendy.reduce((spolu, skore) => spolu + skore.zdrzanie, 0);
  const polia = POLIA.map((pole) => {
    const spravne = agendy.reduce((spolu, skore) => spolu + skore[pole].spravne, 0);
    const znamych = agendy.reduce((spolu, skore) => spolu + skore[pole].znamych, 0);
    return `${pole} ${spravne}/${znamych} ${podiel(spravne, znamych)}`;
  });
  console.log(`${firma.slice(0, 24).padEnd(24)} dokl. ${dokladov}, zdržal sa ${zdrzanie} | ${polia.join(' | ')}`);
}
// Doklady bez IČO aj mena: nevie sa, či je protistrana nová, tak sa aspoň počítajú.
for (const { firma, vysledok } of behy) {
  const neznamych = vysledok.doklady.filter((doklad) => doklad.neznamaProtistrana).length;
  if (neznamych > 0) console.log(`${firma.slice(0, 24).padEnd(24)} neznáma protistrana: ${neznamych} dokl.`);
}
