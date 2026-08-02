#!/usr/bin/env bash
# Obnova Dokladovky zo zálohy: deploy/restore.sh 2026-08-02_030000
#
# PREPÍŠE databázu aj všetky dokumenty. Pred prepísaním si odloží zálohu
# súčasného stavu a overí, že naozaj vznikla — bez nej sa obnova nespustí.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/dokladovka}"
BACKUP_DIR="${BACKUP_DIR:-/root/dokladovka-backups}"
STAMP="${1:-}"

if [ -z "$STAMP" ]; then
  echo "Použitie: $0 <časová-značka>"
  echo "Dostupné zálohy:"
  ls -1 "$BACKUP_DIR"/db-*.dump 2>/dev/null | sed 's|.*/db-||;s|\.dump$||' || echo "  (žiadne)"
  exit 1
fi

DB_FILE="$BACKUP_DIR/db-$STAMP.dump"
OBJ_FILE="$BACKUP_DIR/objects-$STAMP.tar.gz"
[ -f "$DB_FILE" ] || { echo "Chýba $DB_FILE"; exit 1; }
[ -f "$OBJ_FILE" ] || { echo "Chýba $OBJ_FILE"; exit 1; }

cd "$PROJECT_DIR"
echo "Obnova zo zálohy $STAMP prepíše databázu aj všetky dokumenty."
echo "Súčasný stav sa najprv odloží do $BACKUP_DIR."
read -r -p "Pokračovať? Napíšte OBNOVIT: " CONFIRM
[ "$CONFIRM" = "OBNOVIT" ] || { echo "Zrušené."; exit 1; }

# Bezpečnostná sieť. backup.sh pri súbežnom behu (nočný cron, zaseknutý predošlý
# beh) len vypíše „preskočené" a skončí úspechom — bez tejto kontroly by sme
# zmazali dáta bez odloženej kópie. KEEP_DAYS je vypnuté, aby čistenie starých
# záloh nezmazalo práve tú, ktorú ideme obnovovať.
echo "==> odkladám súčasný stav"
BEFORE="$(ls -1 "$BACKUP_DIR"/db-*.dump 2>/dev/null | wc -l)"
BACKUP_DIR="$BACKUP_DIR" PROJECT_DIR="$PROJECT_DIR" KEEP_DAYS=99999 "$PROJECT_DIR/deploy/backup.sh"
AFTER="$(ls -1 "$BACKUP_DIR"/db-*.dump 2>/dev/null | wc -l)"
if [ "$AFTER" -le "$BEFORE" ]; then
  echo "PRERUŠENÉ: záloha súčasného stavu nevznikla (beží iná záloha?). Nič sa nezmenilo."
  exit 1
fi
[ -f "$DB_FILE" ] && [ -f "$OBJ_FILE" ] || { echo "PRERUŠENÉ: zvolená záloha medzitým zmizla."; exit 1; }

# Aplikácia sa zastaví (inak by počas obnovy zapisovala), postgres a web bežia.
echo "==> zastavujem aplikáciu"
docker compose stop api worker imap monitor

# Prázdna schéma pred obnovou. Samotné --clean maže len to, čo je v zálohe —
# pri návrate na staršiu zálohu by tabuľky z novších migrácií prežili, obnova by
# sa polámala a migrácie pri štarte by spadli na „relation already exists".
echo "==> pripravujem prázdnu databázu"
docker compose exec -T postgres psql -U dokladovka -d dokladovka \
  -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' > /dev/null

echo "==> obnovujem databázu"
if ! docker compose exec -T postgres pg_restore -U dokladovka -d dokladovka \
      --no-owner --exit-on-error < "$DB_FILE"; then
  echo
  echo "CHYBA: obnova databázy zlyhala. Dokumenty ostali nedotknuté, aplikácia je zastavená."
  echo "Späť na pôvodný stav: $0 <značka zálohy odloženej pred chvíľou>"
  exit 1
fi

echo "==> obnovujem dokumenty"
docker run --rm -v dokladovka_objects-data:/data -v "$BACKUP_DIR":/backup alpine sh -c \
  "find /data -mindepth 1 -delete && tar xzf /backup/$(basename "$OBJ_FILE") -C /data"

# Štart aplikácie zároveň dobehne migrácie — po obnove staršej zálohy sa schéma
# dotiahne na aktuálnu verziu kódu.
echo "==> spúšťam aplikáciu"
docker compose up -d

echo "==> kontrola"
sleep 8
curl -fsS https://dokladovka.site/api/health || echo "POZOR: /api/health neodpovedá, pozri docker compose logs api"
echo
echo "Obnova zo zálohy $STAMP dokončená."
