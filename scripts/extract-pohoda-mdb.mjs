#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KINDS = ['predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska'];
const TOOLS = ['mdb-tables', 'mdb-schema', 'mdb-export'];
const MAX_TOOL_OUTPUT = 128 * 1024 * 1024;

const KIND_RULES = {
  predkontacie: {
    tablePatterns: [
      [/^ppk$/, 120],
      [/predkont/, 110],
      [/analytika/, 90],
      [/pucet/, 80],
    ],
    codeAliases: ['ids', 'kod', 'code', 'skratka', 'zkratka'],
  },
  cleneniaDph: {
    tablePatterns: [
      [/^sdph$/, 120],
      [/clen.*dph|dph.*clen/, 110],
      [/^sdphtp$/, 70],
      [/classificationvat/, 100],
    ],
    codeAliases: ['ids', 'kod', 'code', 'skratka', 'zkratka'],
  },
  ciselneRady: {
    tablePatterns: [
      [/^scrady$/, 120],
      [/cis.*rad|rad.*cis/, 110],
      [/numericalseries/, 100],
    ],
    codeAliases: ['ids', 'kod', 'code', 'skratka', 'zkratka', 'cislo'],
  },
  strediska: {
    tablePatterns: [
      [/^sstr$/, 120],
      [/stred/, 110],
      [/centre|center/, 90],
    ],
    codeAliases: ['ids', 'kod', 'code', 'skratka', 'zkratka'],
  },
};

const NAME_ALIASES = ['stext', 'nazov', 'name', 'popis'];
const AGENDA_ALIASES = ['agenda'];
const YEAR_ALIASES = ['rok', 'uctovnyrok', 'year'];
const EXACT_TABLES = {
  predkontacie: new Set(['ppk']),
  cleneniaDph: new Set(['sdph']),
  ciselneRady: new Set(['scrady']),
  strediska: new Set(['sstr']),
};

function usage() {
  return [
    'Použitie:',
    '  node scripts/extract-pohoda-mdb.mjs --input "<externá-cesta>/StwPh_35761571_2025.mdb" --ico 35761571',
    '',
    'Ak je tabuľka alebo stĺpec nejednoznačný, zopakujte --map pre každý číselník:',
    '  --map "predkontacie=pPK:IDS:SText"',
    '  --map "cleneniaDph=sDPH:IDS:SText"',
    '  --map "ciselneRady=sCRady:IDS:SText::Rok"',
    '  --map "strediska=sSTR:IDS:SText"',
    '',
    'Formát mapovania:',
    '  --map "<druh>=<tabuľka>[:<kod>[:<nazov>[:<agenda>[:<rok>]]]]"',
    '',
    'Povolené druhy:',
    '  predkontacie, cleneniaDph, ciselneRady, strediska',
    '',
    'Výstup:',
    '  src/data/pohoda/__fixtures__/mdb-extract-{ico}.json',
    '',
    'Požiadavky:',
    '  mdb-tables, mdb-schema a mdb-export musia byť v PATH.',
    '  Na Windows je podporované aj WSL s nainštalovaným balíkom mdbtools.',
    '  Debian/Ubuntu/WSL: sudo apt-get update && sudo apt-get install mdbtools',
    '  macOS (Homebrew): brew install mdbtools',
    '',
    'Bezpečnosť:',
    '  MDB/ACCDB musí byť mimo repozitára. Skript exportuje iba vybrané štyri',
    '  tabuľky a do JSON zapisuje iba kod, nazov a voliteľne agenda/rok.',
  ].join('\n');
}

function fail(message, options = {}) {
  process.stderr.write('Chyba: ' + message + '\n');
  if (options.showUsage) process.stderr.write('\n' + usage() + '\n');
  process.exit(options.exitCode ?? 1);
}

function parseMapping(value) {
  const equalsAt = value.indexOf('=');
  if (equalsAt <= 0 || equalsAt === value.length - 1) {
    fail('Neplatné mapovanie "' + value + '".');
  }
  const kind = value.slice(0, equalsAt);
  if (!KINDS.includes(kind)) fail('Neznámy druh číselníka "' + kind + '".');
  const parts = value.slice(equalsAt + 1).split(':');
  if (parts.length > 5 || !parts[0]) fail('Neplatné mapovanie "' + value + '".');
  return {
    kind,
    table: parts[0],
    kod: parts[1] || undefined,
    nazov: parts[2] || undefined,
    agenda: parts[3] || undefined,
    rok: parts[4] || undefined,
  };
}

function parseArgs(argv) {
  const parsed = { maps: new Map(), help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (!['--input', '--ico', '--map'].includes(arg)) {
      fail('Neznámy argument: ' + arg, { showUsage: true });
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      fail('Prepínač ' + arg + ' vyžaduje hodnotu.', { showUsage: true });
    }
    index += 1;
    if (arg === '--input') parsed.input = value;
    if (arg === '--ico') parsed.ico = value;
    if (arg === '--map') {
      const mapping = parseMapping(value);
      if (parsed.maps.has(mapping.kind)) {
        fail('Mapovanie pre ' + mapping.kind + ' bolo zadané viackrát.');
      }
      parsed.maps.set(mapping.kind, mapping);
    }
  }
  return parsed;
}

function normalizeIdentifier(value) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function locateDirectTool(name) {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  const candidates = [];
  if (process.env.MDBTOOLS_BIN_DIR?.trim()) {
    for (const suffix of suffixes) {
      candidates.push(join(process.env.MDBTOOLS_BIN_DIR.trim(), name + suffix));
    }
  }
  for (const suffix of suffixes) candidates.push(name + suffix);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--help'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    if (!result.error) return candidate;
  }
  return undefined;
}

function runProcess(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'buffer',
    env: {
      ...process.env,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      MDBICONV: 'UTF-8',
      MDB_JET3_CHARSET: 'CP1250',
    },
    maxBuffer: MAX_TOOL_OUTPUT,
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.error) {
    fail('Príkaz ' + command + ' sa nepodarilo spustiť: ' + result.error.message);
  }
  const stdout = decodeToolOutput(result.stdout);
  const stderr = decodeToolOutput(result.stderr).trim();
  if (result.status !== 0) {
    fail(
      'Príkaz ' + command + ' skončil s kódom ' + result.status + '.' +
        (stderr ? ' Detail: ' + stderr : ''),
    );
  }
  return stdout;
}

function decodeToolOutput(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const text = new TextDecoder('utf-8').decode(buffer);
  if (text.includes('\uFFFD')) {
    fail('mdbtools vrátilo neplatný UTF-8 výstup. Skontrolujte MDBICONV=UTF-8.');
  }
  return text.replace(/^\uFEFF/, '');
}

function createToolRunner(inputPath) {
  const direct = new Map(TOOLS.map((name) => [name, locateDirectTool(name)]));
  if ([...direct.values()].every(Boolean)) {
    return {
      mode: 'PATH',
      inputPath,
      run(name, args) {
        return runProcess(direct.get(name), args);
      },
    };
  }

  if (process.platform === 'win32') {
    const wslCheck = spawnSync(
      'wsl.exe',
      ['-e', 'sh', '-lc', 'command -v mdb-tables && command -v mdb-schema && command -v mdb-export'],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
    );
    if (wslCheck.status === 0) {
      const translated = spawnSync('wsl.exe', ['-e', 'wslpath', '-a', inputPath], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      if (translated.status !== 0 || !translated.stdout.trim()) {
        fail('WSL nedokázalo preložiť cestu k MDB.');
      }
      return {
        mode: 'WSL',
        inputPath: translated.stdout.trim(),
        run(name, args) {
          return runProcess('wsl.exe', [
            '-e',
            'env',
            'LANG=C.UTF-8',
            'LC_ALL=C.UTF-8',
            'MDBICONV=UTF-8',
            'MDB_JET3_CHARSET=CP1250',
            name,
            ...args,
          ]);
        },
      };
    }
  }

  const missing = [...direct.entries()]
    .filter((entry) => !entry[1])
    .map((entry) => entry[0])
    .join(', ');
  fail(
    'Chýbajú príkazy mdbtools: ' + (missing || TOOLS.join(', ')) + '. ' +
      'Nainštalujte balík mdbtools a pridajte jeho bin adresár do PATH. ' +
      'Na Windows použite WSL alebo nastavte MDBTOOLS_BIN_DIR.',
    { showUsage: true, exitCode: 3 },
  );
}

function parseTableList(output) {
  const tables = output
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (tables.length === 0) fail('mdb-tables nevrátilo žiadne tabuľky.');
  return [...new Set(tables)];
}

function unquoteIdentifier(value) {
  const trimmed = value.trim().replace(/,$/, '').trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).replace(/]]/g, ']');
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed.split(/\s+/)[0];
}

function parseSchema(schemaSql, knownTables) {
  const byNormalized = new Map(
    knownTables.map((table) => [normalizeIdentifier(table), table]),
  );
  const columnsByTable = new Map(knownTables.map((table) => [table, []]));
  let currentTable;
  for (const rawLine of schemaSql.split(/\r?\n/)) {
    const line = rawLine.trim();
    const create = line.match(/^CREATE\s+TABLE\s+(.+?)(?:\s*\(|$)/i);
    if (create) {
      const parsed = unquoteIdentifier(create[1]);
      currentTable =
        knownTables.find((table) => table === parsed) ??
        byNormalized.get(normalizeIdentifier(parsed));
      continue;
    }
    if (!currentTable) continue;
    if (/^\);?$/.test(line) || /^GO$/i.test(line)) {
      currentTable = undefined;
      continue;
    }
    if (
      !line ||
      line === '(' ||
      /^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(line)
    ) {
      continue;
    }
    const column = line.match(/^(\[[^\]]+\]|"(?:[^"]|"")*"|[^\s,]+)\s+/);
    if (!column) continue;
    const name = unquoteIdentifier(column[1]);
    if (name && !columnsByTable.get(currentTable).includes(name)) {
      columnsByTable.get(currentTable).push(name);
    }
  }
  return columnsByTable;
}

function findColumns(columns, aliases) {
  const allowed = new Set(aliases);
  return columns.filter((column) => allowed.has(normalizeIdentifier(column)));
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function buildCandidates(kind, tables, columnsByTable) {
  const rule = KIND_RULES[kind];
  return tables
    .map((table) => {
      const normalized = normalizeIdentifier(table);
      const score = rule.tablePatterns.reduce(
        (best, entry) => (entry[0].test(normalized) ? Math.max(best, entry[1]) : best),
        0,
      );
      if (score === 0) return undefined;
      const columns = columnsByTable.get(table) ?? [];
      const kodCandidates = findColumns(columns, rule.codeAliases);
      const nazovCandidates = findColumns(columns, NAME_ALIASES);
      const agendaCandidates = findColumns(columns, AGENDA_ALIASES);
      const rokCandidates = findColumns(columns, YEAR_ALIASES);
      return {
        table,
        columns,
        kodCandidates,
        nazovCandidates,
        agendaCandidates,
        rokCandidates,
        score: score + (kodCandidates.length ? 20 : 0) + (nazovCandidates.length ? 20 : 0),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || compareText(left.table, right.table));
}

function resolveExactName(requested, available, label) {
  const matches = available.filter(
    (value) => normalizeIdentifier(value) === normalizeIdentifier(requested),
  );
  if (matches.length !== 1) {
    fail('Neexistujúci alebo nejednoznačný ' + label + ' "' + requested + '".');
  }
  return matches[0];
}

function resolveMapping(kind, explicit, candidates, tables, columnsByTable) {
  let selected;
  if (explicit) {
    const table = resolveExactName(explicit.table, tables, 'názov tabuľky');
    const approvedCandidate = candidates.find(
      (candidate) => normalizeIdentifier(candidate.table) === normalizeIdentifier(table),
    );
    if (!approvedCandidate) {
      fail(
        'Tabuľka ' + table + ' nie je bezpečný kandidát pre ' + kind +
          '. Upravte detekčné pravidlá až po schema-only kontrole; nepoužite inú agendu.',
      );
    }
    const columns = columnsByTable.get(table) ?? [];
    selected = {
      table,
      columns,
      kodCandidates: findColumns(columns, KIND_RULES[kind].codeAliases),
      nazovCandidates: findColumns(columns, NAME_ALIASES),
      agendaCandidates: findColumns(columns, AGENDA_ALIASES),
      rokCandidates: findColumns(columns, YEAR_ALIASES),
    };
  } else if (
    candidates.length === 1 &&
    EXACT_TABLES[kind].has(normalizeIdentifier(candidates[0].table))
  ) {
    selected = candidates[0];
  } else {
    return undefined;
  }

  const choose = (requested, suggestions, label, required) => {
    if (requested) {
      const resolved = resolveExactName(requested, selected.columns, 'stĺpec ' + label);
      if (!suggestions.includes(resolved)) {
        fail(
          'Stĺpec ' + resolved + ' nie je povolený zdroj pre pole ' + label +
            ' v číselníku ' + kind + '.',
        );
      }
      return resolved;
    }
    if (suggestions.length === 1) return suggestions[0];
    if (!required && suggestions.length === 0) return undefined;
    return undefined;
  };
  if (
    (!explicit?.agenda && selected.agendaCandidates.length > 1) ||
    (!explicit?.rok && selected.rokCandidates.length > 1)
  ) {
    return undefined;
  }
  const mapping = {
    kind,
    table: selected.table,
    kod: choose(explicit?.kod, selected.kodCandidates, 'kod', true),
    nazov: choose(explicit?.nazov, selected.nazovCandidates, 'nazov', true),
    agenda: explicit?.agenda
      ? choose(explicit.agenda, selected.agendaCandidates, 'agenda', false)
      : choose(undefined, selected.agendaCandidates, 'agenda', false),
    rok: explicit?.rok
      ? choose(explicit.rok, selected.rokCandidates, 'rok', false)
      : choose(undefined, selected.rokCandidates, 'rok', false),
  };
  if (!mapping.kod || !mapping.nazov) return undefined;
  return mapping;
}

function printCandidates(candidatesByKind, tables, columnsByTable) {
  process.stderr.write(
    'Nemožno bezpečne určiť všetky tabuľky/stĺpce bez explicitného mapovania.\n' +
      'Žiadne riadky neboli exportované. Kandidáti podľa mdb-tables + mdb-schema:\n',
  );
  for (const kind of KINDS) {
    process.stderr.write('\n- ' + kind + ':\n');
    const candidates = candidatesByKind.get(kind) ?? [];
    if (candidates.length === 0) {
      process.stderr.write('  (bez kandidáta)\n');
      continue;
    }
    for (const candidate of candidates) {
      const describe = (values) => (values.length ? values.join('|') : '?');
      process.stderr.write(
        '  ' + candidate.table +
          ': kod=' + describe(candidate.kodCandidates) +
          ', nazov=' + describe(candidate.nazovCandidates) +
          ', agenda=' + describe(candidate.agendaCandidates) +
          ', rok=' + describe(candidate.rokCandidates) +
          '\n',
      );
    }
  }
  process.stderr.write(
    '\nZadajte potvrdené mapovania cez opakovaný --map. Príklad:\n' +
      '  --map "predkontacie=pPK:IDS:SText"\n' +
      '  --map "cleneniaDph=sDPH:IDS:SText"\n' +
      '  --map "ciselneRady=sCRady:IDS:SText::Rok"\n' +
      '  --map "strediska=sSTR:IDS:SText"\n',
  );
  process.stderr.write(
    '\nÚplný schema-only inventár (názvy tabuliek a stĺpcov, bez riadkov):\n',
  );
  for (const table of [...tables].sort(compareText)) {
    const columns = columnsByTable.get(table) ?? [];
    process.stderr.write('  ' + table + ': ' + (columns.join(', ') || '(bez stĺpcov)') + '\n');
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) fail('mdb-export vrátil neukončené úvodzovky v CSV.');
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  return rows.filter((values) => values.some((value) => value !== ''));
}

function normalizeValue(value) {
  const normalized = String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

function compareItems(left, right) {
  return (
    compareText(left.kod, right.kod) ||
    compareText(left.nazov, right.nazov) ||
    compareText(left.agenda ?? '', right.agenda ?? '') ||
    compareText(left.rok ?? '', right.rok ?? '')
  );
}

function exportKind(runner, mapping) {
  const rows = parseCsv(runner.run('mdb-export', [runner.inputPath, mapping.table]));
  if (rows.length === 0) return { items: [], sourceRows: 0, skippedRows: 0 };
  const headers = rows[0].map((value) => value.replace(/^\uFEFF/, '').trim());
  const indexOf = (column) =>
    headers.findIndex(
      (header) => normalizeIdentifier(header) === normalizeIdentifier(column),
    );
  const indexes = {
    kod: indexOf(mapping.kod),
    nazov: indexOf(mapping.nazov),
    agenda: mapping.agenda ? indexOf(mapping.agenda) : -1,
    rok: mapping.rok ? indexOf(mapping.rok) : -1,
  };
  if (indexes.kod < 0 || indexes.nazov < 0) {
    fail('Hlavička exportu tabuľky ' + mapping.table + ' nezodpovedá mapovaniu.');
  }
  const unique = new Map();
  let skippedRows = 0;
  for (const values of rows.slice(1)) {
    const kod = normalizeValue(values[indexes.kod]);
    const nazov = normalizeValue(values[indexes.nazov]);
    if (!kod || !nazov) {
      skippedRows += 1;
      continue;
    }
    const item = { kod, nazov };
    if (indexes.agenda >= 0) {
      const agenda = normalizeValue(values[indexes.agenda]);
      if (agenda) item.agenda = agenda;
    }
    if (indexes.rok >= 0) {
      const rok = normalizeValue(values[indexes.rok]);
      if (rok) item.rok = rok;
    }
    unique.set(JSON.stringify(item), item);
  }
  const sourceRows = rows.length - 1;
  const items = [...unique.values()].sort(compareItems);
  if (sourceRows > 0 && items.length === 0) {
    fail(
      'Tabuľka ' + mapping.table +
        ' obsahuje riadky, ale po bezpečnom výbere kod/nazov nevznikol žiadny záznam.',
    );
  }
  return { items, sourceRows, skippedRows };
}

function assertFixturePrivacy(fixture) {
  const rootKeys = Object.keys(fixture);
  if (rootKeys.length !== KINDS.length || rootKeys.some((key) => !KINDS.includes(key))) {
    fail('Interná kontrola fixture našla neočakávaný koreňový kľúč.');
  }
  const allowed = new Set(['kod', 'nazov', 'agenda', 'rok']);
  const emailPattern = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i;
  const ibanPattern = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/i;
  for (const kind of KINDS) {
    if (!Array.isArray(fixture[kind])) fail('Fixture ' + kind + ' nie je pole.');
    for (const item of fixture[kind]) {
      const keys = Object.keys(item);
      if (
        !keys.includes('kod') ||
        !keys.includes('nazov') ||
        keys.some((key) => !allowed.has(key))
      ) {
        fail('Fixture obsahuje nepovolené pole v ' + kind + '.');
      }
      for (const value of Object.values(item)) {
        if (emailPattern.test(value) || ibanPattern.test(value.replace(/\s+/g, ''))) {
          fail('Fixture ' + kind + ' obsahuje hodnotu podobnú e-mailu alebo IBAN-u.');
        }
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (!args.input || !args.ico) {
    fail('Argumenty --input a --ico sú povinné.', { showUsage: true });
  }
  if (!/^\d{8}$/.test(args.ico)) fail('--ico musí obsahovať presne 8 číslic.');

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const input = resolve(args.input);
  if (!existsSync(input) || !statSync(input).isFile()) {
    fail('Vstupný MDB neexistuje alebo nie je súbor: ' + input);
  }
  if (!['.mdb', '.accdb'].includes(extname(input).toLowerCase())) {
    fail('Vstup musí mať príponu .mdb alebo .accdb.');
  }
  const realInput = realpathSync(input);
  const relativeToRepo = relative(realpathSync(repoRoot), realInput);
  if (!relativeToRepo.startsWith('..') && !isAbsolute(relativeToRepo)) {
    fail('Vstupný MDB/ACCDB musí byť mimo repozitára.');
  }

  const runner = createToolRunner(realInput);
  const tables = parseTableList(runner.run('mdb-tables', ['-1', runner.inputPath]));
  const columnsByTable = parseSchema(
    runner.run('mdb-schema', [runner.inputPath]),
    tables,
  );
  const candidatesByKind = new Map(
    KINDS.map((kind) => [kind, buildCandidates(kind, tables, columnsByTable)]),
  );
  const mappings = new Map();
  for (const kind of KINDS) {
    const mapping = resolveMapping(
      kind,
      args.maps.get(kind),
      candidatesByKind.get(kind),
      tables,
      columnsByTable,
    );
    if (mapping) mappings.set(kind, mapping);
  }
  if (mappings.size !== KINDS.length) {
    printCandidates(candidatesByKind, tables, columnsByTable);
    process.exit(2);
  }

  const exported = new Map(
    KINDS.map((kind) => [kind, exportKind(runner, mappings.get(kind))]),
  );
  const fixture = Object.fromEntries(
    KINDS.map((kind) => [kind, exported.get(kind).items]),
  );
  assertFixturePrivacy(fixture);
  const output = join(
    repoRoot,
    'src',
    'data',
    'pohoda',
    '__fixtures__',
    'mdb-extract-' + args.ico + '.json',
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(fixture, null, 2) + '\n', 'utf8');

  process.stdout.write('mdbtools režim: ' + runner.mode + '\n');
  for (const kind of KINDS) {
    const mapping = mappings.get(kind);
    const optional = [
      mapping.agenda ? 'agenda=' + mapping.agenda : undefined,
      mapping.rok ? 'rok=' + mapping.rok : undefined,
    ].filter(Boolean);
    process.stdout.write(
      kind +
        ': tabuľka=' + mapping.table +
        ', kod=' + mapping.kod +
        ', nazov=' + mapping.nazov +
        (optional.length ? ', ' + optional.join(', ') : '') +
        ', záznamy=' + fixture[kind].length +
        ', zdrojovéRiadky=' + exported.get(kind).sourceRows +
        ', preskočené=' + exported.get(kind).skippedRows +
        '\n',
    );
  }
  process.stdout.write('Fixture: ' + output + '\n');
  process.stdout.write(
    'IČO ' + args.ico +
      ' bolo potvrdené argumentom --ico; kvôli súkromiu sa nečítala iná MDB agenda.\n',
  );
  process.stdout.write('Kontrola súkromia: iba kod/nazov/agenda/rok; bez e-mailov a IBAN.\n');
}

main();
