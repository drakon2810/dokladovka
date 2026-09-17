import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { HttpError } from '../http.js';
import {
  POLIA, PROFILY_MERANIA, castostOtazok, intervalSpolahlivosti, porovnajBehy, presnostNadPrahom, zmerajPresnost,
  type OknoMerania, type PresnostVysledok, type ProfilMerania, type RezimMerania,
} from '../services/uctoPresnostService.js';

/**
 * Presnosť návrhu zaúčtovania pre všetky firmy naraz. Jedno číslo klame, preto
 * tabuľka po firme, agende a poli a pod ňou mikro (všetky doklady spolu), makro
 * (priemer firiem) a najhoršia firma s intervalom. Nič nezapisuje.
 *
 * Produkcia, len na čítanie — databáza každý pokus o zápis odmietne:
 *   docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' api node build/server/scripts/zmerajPresnost.js --rezim bez_ai
 * Voľby: --rezim bez_ai|ai  --okno test|validacia  --vzorka N  --max-volani N  --kategorie  --bez-historie  --firma časť_názvu|id
 *        --profil k_datumu|potvrdeny|vypnuty (aj viac naraz čiarkou, napr. vypnuty,potvrdeny)
 * --bez-historie meria firmu bez histórie (R18): návrh nevidí nič, čo firma
 * robila — len číselníky a nastavenia; kategórie sa vtedy nepoužijú.
 * --profil: k_datumu (predvolene) = fakty profilu potvrdené pred dokladom;
 * potvrdeny = dnešné fakty aj na minulé doklady — retrospektívne použitie
 * dnešnej politiky, nie historická presnosť; vypnuty = bez faktov. Viac
 * profilov sa zmeria na tej istej vzorke a vypíšu sa párové rozdiely voči prvému.
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
    'bez-historie': { type: 'boolean', default: false },
    firma: { type: 'string' },
    profil: { type: 'string', default: 'k_datumu' },
  },
});
const profily = [...new Set(values.profil.split(','))] as ProfilMerania[];
if (!['bez_ai', 'ai'].includes(values.rezim) || !['test', 'validacia'].includes(values.okno)
  || !profily.every((profil) => PROFILY_MERANIA.includes(profil))) {
  throw new Error('Použitie: --rezim bez_ai|ai --okno test|validacia [--vzorka N] [--max-volani N] [--kategorie] [--bez-historie] [--firma časť_názvu|id] [--profil k_datumu|potvrdeny|vypnuty[,…]]');
}

const config = loadConfig();
const database = await createDatabase(config);
const behy: Array<{ firma: string; profil: ProfilMerania; vysledok: PresnostVysledok }> = [];
/** Firma vo výpise; iný než predvolený profil je v názve, nech sa behy nepomýlia. */
const sProfilom = profily.length > 1 || profily[0] !== 'k_datumu';
const sirka = sProfilom ? 36 : 24;
const nazov = (beh: { firma: string; profil: ProfilMerania }) =>
  (sProfilom ? `${beh.firma} [${beh.profil}]` : beh.firma).slice(0, sirka).padEnd(sirka);
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
    // Podiel zo zvyšku rozpočtu, rovnaký pre každý profil firmy — párované behy
    // musia mať tú istú vzorku; vzorka ho nikdy neprekročí (vyberVzorku).
    const naBeh = Math.floor(Math.ceil(zostatok / (firmy.length - poradie)) / profily.length);
    if (sAi && naBeh <= 0) {
      console.error(`Rozpočet volaní nestačí na ${profily.length} profily — ${firmy.length - poradie} firiem sa nemeralo.`);
      break;
    }
    try {
      for (const profil of profily) {
        const vysledok = await zmerajPresnost(database, config, { tenantId: firma.tenant_id, organizationId: firma.id }, {
          rezim: values.rezim as RezimMerania,
          okno: values.okno as OknoMerania,
          vzorka: values.vzorka ? Number(values.vzorka) : undefined,
          maxAiVolani: sAi ? naBeh : undefined,
          kategorie: values.kategorie,
          bezHistorie: values['bez-historie'],
          profil,
        });
        if (sAi) zostatok -= vysledok.vzorka;
        behy.push({ firma: firma.name, profil, vysledok });
      }
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

// Výsledok bez histórie sa nesmie čítať ako presnosť firmy s praxou.
if (values['bez-historie']) console.log('\nFIRMA BEZ HISTÓRIE — návrh nevidel nič z histórie firmy, len číselníky a nastavenia');
// Ani dnešný profil na minulých dokladoch sa nesmie čítať ako historická presnosť.
if (profily.includes('potvrdeny')) {
  console.log('\nPROFIL POTVRDENÝ — dnešné potvrdené fakty aj na minulé doklady: retrospektívne použitie dnešnej politiky, nie historická presnosť');
}
if (profily.includes('vypnuty')) console.log('\nPROFIL VYPNUTÝ — návrh nevidel žiadny fakt profilu klienta');
const podiel = (spravne: number, znamych: number) => (znamych > 0 ? `${((spravne / znamych) * 100).toFixed(1)} %` : '—');
console.log(`\n${'firma'.padEnd(sirka)} ${'agenda'.padEnd(6)} dokl. ${POLIA.map((pole) => pole.padStart(20)).join('')}  zdržal sa`);
for (const beh of behy) {
  for (const [agenda, skore] of Object.entries(beh.vysledok.vysledok)) {
    const polia = POLIA.map((pole) => `${skore[pole].spravne}/${skore[pole].znamych} ${podiel(skore[pole].spravne, skore[pole].znamych)}`.padStart(20));
    console.log(`${nazov(beh)} ${agenda.padEnd(6)} ${String(skore.dokladov).padStart(5)} ${polia.join('')}  ${skore.zdrzanie}`);
  }
}

console.log('');
for (const pole of POLIA) for (const profil of profily) {
  // Mikro a makro v rámci jedného profilu — behy rôznych profilov sa nemiešajú.
  const firmy = behy.filter((beh) => beh.profil === profil).map(({ firma, vysledok }) => {
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
  console.log(`${pole.padEnd(12)}${sProfilom ? ` [${profil}]` : ''} mikro ${mikro}  makro ${makro}  najhoršia ${najhorsia.firma} `
    + `${podiel(najhorsia.spravne, najhorsia.znamych)}${interval}`);
}

// Predvyplnenie od istoty 0,9: aká presná je hodnota, ktorú účtovník neotvorí,
// a koľko dokladov sa tak vyplní. Pod 20 dokladmi nad prahom len „málo dokladov".
console.log('\nnad prahom predvyplnenia (istota ≥ 0,9)');
for (const beh of behy) {
  const polia = POLIA.map((pole) => {
    const nad = presnostNadPrahom(beh.vysledok.doklady, pole);
    const pokrytie = `pokrytie ${(nad.pokrytie * 100).toFixed(0)} %`;
    if (!nad.interval) return `${pole} málo dokladov (${nad.navrhnutych}), ${pokrytie}`;
    return `${pole} ${podiel(nad.spravnych, nad.navrhnutych)} (95 % ${(nad.interval[0] * 100).toFixed(1)}–`
      + `${(nad.interval[1] * 100).toFixed(1)} %), ${pokrytie}`;
  });
  console.log(`${nazov(beh)} ${polia.join(' | ')}`);
}

// Nová protistrana: pravidlo ani denník protistrany tu nepomôžu, rozhoduje druh
// plnenia. V celkovom čísle ju prekryjú známi dodávatelia, preto zvlášť.
console.log('\nnová protistrana (firma ju pred dátumom dokladu nemala)');
for (const beh of behy) {
  const agendy = Object.values(beh.vysledok.vysledokNovaProtistrana);
  const dokladov = agendy.reduce((spolu, skore) => spolu + skore.dokladov, 0);
  if (dokladov === 0) continue;
  const zdrzanie = agendy.reduce((spolu, skore) => spolu + skore.zdrzanie, 0);
  const polia = POLIA.map((pole) => {
    const spravne = agendy.reduce((spolu, skore) => spolu + skore[pole].spravne, 0);
    const znamych = agendy.reduce((spolu, skore) => spolu + skore[pole].znamych, 0);
    return `${pole} ${spravne}/${znamych} ${podiel(spravne, znamych)}`;
  });
  console.log(`${nazov(beh)} dokl. ${dokladov}, zdržal sa ${zdrzanie} | ${polia.join(' | ')}`);
}
// Koľko otázok by účtovník dostal, keby sa systém pýtal namiesto hádania (R09).
console.log('\notázky účtovníkovi (spor praxí v DPH/KV alebo nová protistrana; cieľ ≤ 10–15 %)');
for (const beh of behy) {
  const castost = castostOtazok(beh.vysledok.doklady);
  if (castost.dokladov === 0) continue;
  console.log(`${nazov(beh)} otázky ${castost.otazky}/${castost.dokladov} ${podiel(castost.otazky, castost.dokladov)}`
    + ` (spor v DPH/KV ${castost.sporDph}, nová protistrana ${castost.novaProtistrana})`
    + ` | ponuka bez predvyplnenia (spor len v účte) ${castost.ponukyBezPredvyplnenia}`);
}
// Doklady bez IČO aj mena: nevie sa, či je protistrana nová, tak sa aspoň počítajú.
for (const beh of behy) {
  const neznamych = beh.vysledok.doklady.filter((doklad) => doklad.neznamaProtistrana).length;
  if (neznamych > 0) console.log(`${nazov(beh)} neznáma protistrana: ${neznamych} dokl.`);
}

// Párové rozdiely na tej istej vzorke voči prvému profilu z --profil.
if (profily.length > 1) {
  console.log(`\npárové rozdiely voči profilu ${profily[0]} (zmenené doklady; po poliach +lepšie −horšie)`);
  for (const beh of behy.filter((item) => item.profil !== profily[0])) {
    const zaklad = behy.find((item) => item.profil === profily[0] && item.firma === beh.firma);
    if (!zaklad) continue;
    const rozdiel = porovnajBehy(zaklad.vysledok.doklady, beh.vysledok.doklady);
    const polia = POLIA.map((pole) => `${pole} +${rozdiel.polia[pole].lepsie} −${rozdiel.polia[pole].horsie}`);
    console.log(`${nazov(beh)} zmenených ${rozdiel.zmenenych}/${rozdiel.parov}`
      + `${rozdiel.bezParu > 0 ? ` (bez páru ${rozdiel.bezParu} — vzorky sa líšia)` : ''} | ${polia.join(' | ')}`);
  }
}
