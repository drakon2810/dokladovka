import type { Queryable } from '../db/database.js';

/**
 * Idempotentné doplnenie po importe číselníkov z POHODY: predkontácia bez
 * atribútu debit dostane účet MD z prefixu kódu (účtovníci často kódujú
 * „501199 PHM NEDANOVA"). Účet POHODY sa nikdy neprepíše.
 */
export async function doplnUcetMdZKodu(tx: Queryable, tenantId: string, organizationId: string): Promise<void> {
  await tx.query(
    `UPDATE code_list_items
        SET ucet_md = substring(code from '^[0-9]{3,6}')
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='predkontacie' AND ucet_md IS NULL`,
    [tenantId, organizationId],
  );
}
