// IMAP poller proces — samostatný, ako worker/monitor.
// Číta schránku (Gmail app password), nové správy posiela do inbound webhooku
// a po úspešnom prijatí ich označí ako prečítané. Idempotenciu rieši webhook
// cez providerMessageId, takže pád medzi POST a označením nič nezduplikuje.
import { setTimeout as delay } from 'node:timers/promises';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { loadConfig } from './config.js';
import { buildWebhookPayload, deliverToWebhook, type ParsedImapMessage } from './inbound/imapPoller.js';

const config = loadConfig();
if (!config.imap.host || !config.imap.user || !config.imap.password) {
  throw new Error('IMAP_HOST, IMAP_USER a IMAP_PASSWORD sú povinné pre IMAP poller (.env)');
}

const log = (message: string) => console.log(`[imap ${new Date().toISOString()}] ${message}`);

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((entry) => entry.value.map((addr) => addr.address ?? '')).filter(Boolean);
}

function headerValues(headers: Map<string, unknown>, name: string): string[] {
  const value = headers.get(name);
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

async function pollOnce(): Promise<void> {
  const client = new ImapFlow({
    host: config.imap.host!,
    port: config.imap.port,
    secure: true,
    auth: { user: config.imap.user!, pass: config.imap.password! },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.imap.mailbox);
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      if (!unseen || unseen.length === 0) return;
      log(`nové správy: ${unseen.length}`);

      for (const uid of unseen) {
        try {
          const fetched = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!fetched || !fetched.source) {
            log(`uid ${uid}: správu sa nepodarilo stiahnuť, preskakujem`);
            continue;
          }
          const parsed = await simpleParser(fetched.source);
          const message: ParsedImapMessage = {
            uid,
            messageId: parsed.messageId ?? undefined,
            senderEmail: parsed.from?.value[0]?.address ?? undefined,
            senderName: parsed.from?.value[0]?.name || undefined,
            subject: parsed.subject ?? undefined,
            date: parsed.date ?? undefined,
            recipients: [
              ...addressList(parsed.to),
              ...addressList(parsed.cc),
              ...headerValues(parsed.headers as Map<string, unknown>, 'delivered-to'),
              ...headerValues(parsed.headers as Map<string, unknown>, 'x-original-to'),
            ],
            attachments: parsed.attachments.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.contentType,
              content: attachment.content,
            })),
          };
          const payload = buildWebhookPayload(message, config);
          const result = await deliverToWebhook(payload, {
            apiBaseUrl: config.apiBaseUrl,
            webhookSecret: config.webhookSecret,
          });
          if (result.ok) {
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            const info = result.body as { duplicate?: boolean; queued?: number; status?: string } | undefined;
            log(
              `uid ${uid}: prijaté (${payload.attachments.length} príloh, ` +
              `${info?.duplicate ? 'duplicate' : `queued=${info?.queued ?? 0}, status=${info?.status ?? '?'}`})`,
            );
          } else {
            // Nechávame neprečítané — skúsi sa znova v ďalšom cykle.
            log(`uid ${uid}: webhook odmietol so stavom ${result.status}, skúsim neskôr`);
          }
        } catch (error) {
          const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
          log(`uid ${uid}: chyba spracovania — ${error instanceof Error ? error.message : String(error)}${cause}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

log(`štart: ${config.imap.user} @ ${config.imap.host}:${config.imap.port}, interval ${config.imap.pollIntervalSeconds}s`);
while (!stopping) {
  try {
    await pollOnce();
  } catch (error) {
    // Sieťové výpadky a pod. — zalogovať a pokračovať v ďalšom cykle.
    log(`cyklus zlyhal — ${error instanceof Error ? error.message : String(error)}`);
  }
  await delay(config.imap.pollIntervalSeconds * 1000);
}
