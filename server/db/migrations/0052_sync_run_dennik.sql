-- Telemetria synchronizácie pozná aj korpus histórie a účtovný denník.
--
-- To isté, čo migrácia 0046 riešila pri adresári, platilo celý čas aj pre
-- korpus histórie: agent posiela výsledok pod kindom „uctovnyProfil", ktorý
-- nebol ani v zod schéme route, ani v CHECK-u tabuľky. Požiadavka teda padla
-- na 400, agent ju posiela cez „Try" a chybu si zapísal len do vlastného logu.
-- Na serveri po synchronizácii histórie nebolo ani stopy — vyzeralo to, akoby
-- vôbec nebežala.
--
-- Denník pribúda teraz, nech nezopakuje ten istý osud.
ALTER TABLE agent_sync_runs DROP CONSTRAINT agent_sync_runs_kind_check;
ALTER TABLE agent_sync_runs ADD CONSTRAINT agent_sync_runs_kind_check
  CHECK (kind IN ('predkontacie', 'cleneniaDph', 'ciselneRady', 'strediska',
                  'bankoveUcty', 'treningAi', 'adresar',
                  'uctovnyProfil', 'uctovnyDennik'));
