#!/usr/bin/env bash
# Nočná záloha Dokladovky: databáza + dokumenty + .env.
#
# Spúšťa ju cron na serveri (deploy/install-backup-cron.sh). Zálohy sú lokálne
# na VPS — chránia pred zlým nasadením, chybou v aplikácii a omylom používateľa,
# NIE pred stratou celého servera. Odvoz mimo VPS zapneš cez BACKUP_REMOTE nižšie.
#
# Poradie je zámerné: najprv databáza, potom súbory. Dokument nahraný medzi
# krokmi tak skončí ako súbor bez riadku v DB (neškodné) namiesto riadku bez
# súboru (rozbitý doklad).
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/dokladovka}"
BACKUP_DIR="${BACKUP_DIR:-/root/dokladovka-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
# Voliteľné: cieľ pre `rsync` mimo VPS, napr. "user@host:/zalohy/dokladovka".
BACKUP_REMOTE="${BACKUP_REMOTE:-}"

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
STAMP="$(date +%F_%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Dve zálohy naraz by si prepisovali súbory a zdvojili záťaž — druhý beh počká.
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { echo "$(date -Is) preskočené: beží iná záloha"; exit 0; }

cd "$PROJECT_DIR"
DB_FILE="$BACKUP_DIR/db-$STAMP.dump"
OBJ_FILE="$BACKUP_DIR/objects-$STAMP.tar.gz"
ENV_FILE="$BACKUP_DIR/env-$STAMP.txt"

fail() {
  echo "$(date -Is) ZLYHALO: $1"
  echo "$(date -Is) ZLYHALO: $1" > "$BACKUP_DIR/last-status.txt"
  rm -f "$DB_FILE" "$OBJ_FILE" "$ENV_FILE"
  exit 1
}

echo "$(date -Is) záloha $STAMP — štart"

# 1) Databáza vo formáte -Fc: komprimovaná a pg_restore z nej vie obnoviť aj
#    jednotlivé tabuľky. Bez -T by exec pripojil TTY a výstup by sa poškodil.
docker compose exec -T postgres pg_dump -U dokladovka -Fc dokladovka > "$DB_FILE" \
  || fail "pg_dump neprešiel"
[ -s "$DB_FILE" ] || fail "dump databázy je prázdny"

# 2) Dokumenty (PDF prijatých dokladov) žijú v docker volume, nie v priečinku
#    projektu — čítame ich cez dočasný kontajner pripojený read-only.
docker run --rm \
  -v dokladovka_objects-data:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar czf "/backup/$(basename "$OBJ_FILE")" -C /data . \
  || fail "archív dokumentov sa nepodaril"

# 3) .env drží heslá a tokeny — bez neho sa server po obnove nerozbehne.
cp "$PROJECT_DIR/.env" "$ENV_FILE" || fail ".env sa nepodarilo skopírovať"
chmod 600 "$ENV_FILE"

# 4) Overenie, že záloha je čitateľná. pg_restore --list prečíta obsah dumpu,
#    takže odhalí aj skrátený súbor — nielen to, že niečo vzniklo.
docker run --rm -v "$BACKUP_DIR":/backup postgres:17-alpine \
  pg_restore --list "/backup/$(basename "$DB_FILE")" > /dev/null \
  || fail "dump databázy sa nedá prečítať"
tar tzf "$OBJ_FILE" > /dev/null || fail "archív dokumentov sa nedá prečítať"

# 5) Odvoz mimo servera (ak je nastavený) — lokálna záloha neprežije stratu disku.
if [ -n "$BACKUP_REMOTE" ]; then
  rsync -a --delete "$BACKUP_DIR/" "$BACKUP_REMOTE/" || fail "rsync mimo VPS zlyhal"
fi

# 6) Staršie zálohy sa mažú až po úspešnom overení tej dnešnej.
find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'objects-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'env-*.txt' -mtime +"$KEEP_DAYS" -delete

SIZE="$(du -ch "$DB_FILE" "$OBJ_FILE" | tail -1 | cut -f1)"
echo "$(date -Is) OK $STAMP ($SIZE)" > "$BACKUP_DIR/last-status.txt"
echo "$(date -Is) záloha $STAMP hotová ($SIZE)"
