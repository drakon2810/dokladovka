-- Voľba „Nekontrolovať duplicity" v exportnom dialógu: agent pošle POHODE
-- check_duplicity=0, takže sa dá znovu naimportovať doklad, ktorý tam už je.
ALTER TABLE export_jobs ADD COLUMN check_duplicity boolean NOT NULL DEFAULT true;
