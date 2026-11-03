import nodemailer, { type Transporter } from 'nodemailer';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import type { SettingsService } from './settings.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

export interface MailResult {
  accepted: boolean;
  response: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<MailResult>;
  describe(): string;
}

/** In-memory sink for tests. */
export class MemoryMailer implements Mailer {
  sent: MailMessage[] = [];
  failNext: Error | null = null;
  async send(msg: MailMessage): Promise<MailResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.sent.push(msg);
    return { accepted: true, response: 'memory' };
  }
  describe() {
    return 'memory';
  }
}

/** Writes .eml files to a directory – a development sink that can never reach a real inbox. */
export class FileMailer implements Mailer {
  constructor(private readonly dir: string) {}
  async send(msg: MailMessage): Promise<MailResult> {
    await fs.mkdir(this.dir, { recursive: true });
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.eml`;
    const raw = [`To: ${msg.to}`, `Subject: ${msg.subject}`, 'Content-Type: text/plain; charset=utf-8', '', msg.text, '', '--- html ---', msg.html].join('\n');
    await fs.writeFile(path.join(this.dir, name), raw, { mode: 0o600 });
    return { accepted: true, response: `file:${name}` };
  }
  describe() {
    return `file:${this.dir}`;
  }
}

/** SMTP via nodemailer. Settings in the database override SMTP_URL. */
export class SmtpMailer implements Mailer {
  private transport: Transporter | null = null;
  private signature = '';
  constructor(
    private readonly config: Config,
    private readonly settings: SettingsService,
  ) {}

  private async getTransport(): Promise<{ t: Transporter; from: string; replyTo?: string }> {
    const s = await this.settings.get('smtp');
    // Always read the stored secret rather than trusting the derived flag.
    const password = await this.settings.getSecret('smtp.password');
    const sig = JSON.stringify([s.host, s.port, s.secure, s.username, password ? password.length : 0, this.config.SMTP_URL]);
    if (!this.transport || sig !== this.signature) {
      if (s.host) {
        this.transport = nodemailer.createTransport({
          host: s.host,
          port: s.port,
          secure: s.secure,
          auth: s.username ? { user: s.username, pass: password ?? '' } : undefined,
          connectionTimeout: 15_000,
          socketTimeout: 30_000,
        });
      } else if (this.config.SMTP_URL) {
        this.transport = nodemailer.createTransport(this.config.SMTP_URL);
      } else {
        throw new Error('SMTP is not configured');
      }
      this.signature = sig;
    }
    return { t: this.transport, from: s.from || this.config.SMTP_FROM, replyTo: s.replyTo || undefined };
  }

  async send(msg: MailMessage): Promise<MailResult> {
    const { t, from, replyTo } = await this.getTransport();
    const info = await t.sendMail({ from, replyTo, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers });
    return { accepted: (info.accepted?.length ?? 0) > 0, response: String(info.response ?? '').slice(0, 200) };
  }

  async verify(): Promise<{ ok: boolean; error?: string }> {
    try {
      const { t } = await this.getTransport();
      await t.verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  describe() {
    return 'smtp';
  }
}

export function createMailer(config: Config, settings: SettingsService): Mailer {
  if (config.MAIL_TRANSPORT === 'memory') return new MemoryMailer();
  if (config.MAIL_TRANSPORT === 'file') return new FileMailer(config.MAIL_FILE_DIR ?? path.join(process.cwd(), 'var', 'mail'));
  return new SmtpMailer(config, settings);
}
