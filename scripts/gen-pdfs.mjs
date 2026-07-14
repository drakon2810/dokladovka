import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const outputDir = join(process.cwd(), 'public', 'samples');

const samples = [
  ['faktura-sluzby.pdf', 'Dodavatel sluzieb s.r.o.', 'FV-2026-001', 'Poradenske sluzby', 1230],
  ['faktura-telekom.pdf', 'Slovak Telekom, a.s.', '8412345601', 'Telekomunikacne sluzby', 56.46],
  ['faktura-energia.pdf', 'ZSE Energia, a.s.', '7300221144', 'Dodavka elektriny', 384.25],
  ['faktura-kancelarske.pdf', 'OFFICEO s.r.o.', '20260455', 'Kancelarske potreby', 110.09],
  ['faktura-metro.pdf', 'METRO Cash & Carry SR', '4426009911', 'Tovar', 369.45],
  ['faktura-alza.pdf', 'Alza.sk s. r. o.', '2261004488', 'Vypoctova technika', 1536.48],
  ['faktura-servis.pdf', 'AutoServis Krajcir s.r.o.', '2026077', 'Servisne prace', 430.5],
  ['vypis-banka.pdf', 'Tatra banka, a.s.', 'VYPIS-2026-06', 'Bankovy vypis', 0],
  ['mzdy-podklad.pdf', 'Interne mzdove podklady', 'MZDY-2026-06', 'Mzdy', 8450],
];

function money(value) {
  return `${value.toFixed(2)} EUR`;
}

async function createSample([fileName, supplier, number, description, total]) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dark = rgb(0.11, 0.12, 0.11);
  const muted = rgb(0.36, 0.39, 0.37);
  const accent = rgb(0.055, 0.478, 0.373);

  page.drawText('FAKTURA / DOKLAD', { x: 48, y: 780, size: 20, font: bold, color: dark });
  page.drawRectangle({ x: 48, y: 765, width: 499, height: 3, color: accent });
  page.drawText(supplier, { x: 48, y: 730, size: 13, font: bold, color: dark });
  page.drawText(`Cislo dokladu: ${number}`, { x: 355, y: 730, size: 10, font: regular, color: muted });
  page.drawText('Odberatel: Alfa Trade s.r.o. | ICO 36123456', {
    x: 48,
    y: 690,
    size: 10,
    font: regular,
    color: muted,
  });
  page.drawText('Datum vystavenia: 28. 06. 2026', { x: 48, y: 662, size: 10, font: regular, color: muted });
  page.drawText('Datum splatnosti: 12. 07. 2026', { x: 315, y: 662, size: 10, font: regular, color: muted });

  page.drawRectangle({ x: 48, y: 585, width: 499, height: 34, color: rgb(0.96, 0.97, 0.96) });
  page.drawText('Popis', { x: 58, y: 598, size: 10, font: bold, color: dark });
  page.drawText('Sadzba DPH', { x: 350, y: 598, size: 10, font: bold, color: dark });
  page.drawText('Spolu', { x: 485, y: 598, size: 10, font: bold, color: dark });
  page.drawText(description, { x: 58, y: 558, size: 10, font: regular, color: dark });
  page.drawText(total === 0 ? '0 %' : '23 %', { x: 370, y: 558, size: 10, font: regular, color: dark });
  page.drawText(money(total), { x: 465, y: 558, size: 10, font: bold, color: dark });

  page.drawText(`SPOLU NA UHRADU: ${money(total)}`, {
    x: 335,
    y: 480,
    size: 14,
    font: bold,
    color: accent,
  });
  page.drawText('Demo PDF pre lokalny prototyp Dokladovka.', {
    x: 48,
    y: 64,
    size: 9,
    font: regular,
    color: muted,
  });

  await writeFile(join(outputDir, fileName), await pdf.save());
}

await mkdir(outputDir, { recursive: true });
await Promise.all(samples.map(createSample));
console.log(`Vygenerovanych ${samples.length} PDF suborov v ${outputDir}`);
