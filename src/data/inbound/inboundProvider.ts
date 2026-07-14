// Provider boundary pre production inbound webhook (SPEC §11.4).
// Fáza 1 používa iba mock adaptér; overenie podpisu, provisioning route a
// storage patria výhradne na backend vo Fáze 2A.

export type EmailProvisioningMode = 'catch_all' | 'provider_alias';

export interface ParsedInboundAttachment {
  fileName: string;
  declaredMimeType?: string;
  byteSize: number;
}

export interface ParsedInboundEmail {
  provider: string;
  providerMessageId: string;
  envelopeRecipients: string[];
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  receivedAt: string;
  attachments: ParsedInboundAttachment[];
}

export interface InboundEmailProvider {
  verifyWebhook(request: Request): Promise<boolean>;
  parseWebhook(request: Request): Promise<ParsedInboundEmail>;
  provisionAlias?(address: string): Promise<{ providerRouteId: string }>;
  disableAlias?(providerRouteId: string): Promise<void>;
}

/** Dev adaptér s explicitným JSON kontraktom, bez siete a secrets. */
export class MockInboundEmailProvider implements InboundEmailProvider {
  async verifyWebhook(): Promise<boolean> {
    return true;
  }

  async parseWebhook(request: Request): Promise<ParsedInboundEmail> {
    return (await request.json()) as ParsedInboundEmail;
  }
}
