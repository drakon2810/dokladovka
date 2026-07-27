import nodemailer from 'nodemailer';
import type { ServerConfig } from './config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * SMTP odosielanie. Bez SMTP_HOST (dev, testy) sa správa iba zaloguje —
 * registračný kód a odkaz na obnovu hesla tak zostanú dostupné lokálne.
 */
export function createMailer(config: ServerConfig): Mailer {
  const { host, port, secure, user, password } = config.mail.smtp;
  if (!host) {
    return {
      async send(message) {
        // Telo obsahuje registračný kód aj odkaz na obnovu hesla — do
        // produkčných logov nesmie. Radšej hlasné zlyhanie než tichý únik.
        if (config.nodeEnv === 'production') {
          throw new Error('SMTP_HOST nie je nastavené — e-mail sa nedá odoslať');
        }
        console.info(`[mail] pre ${message.to} — ${message.subject}\n${message.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass: password } : undefined,
  });
  return {
    async send(message) {
      await transport.sendMail({ from: config.mail.from, ...message });
    },
  };
}
