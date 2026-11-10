import { formatDateTimeLong } from '@securesend/shared';
import type { Rendered, TemplateContext } from './templates.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Invitation to SEND files in. Like every invitation it carries no title, message or filenames;
 * those are shown only after the contributor has verified their mailbox.
 */
export const requestTemplates = {
  file_request(ctx: TemplateContext, d: { requesterName: string; requesterEmail: string; link: string; expiresAt: string; reminder?: boolean }): Rendered {
    const when = formatDateTimeLong(d.expiresAt, ctx.timeZone);
    const subject = d.reminder ? `Reminder: ${d.requesterName} is waiting for your files` : `${d.requesterName} has asked you to send files via ${ctx.productName}`;
    const text = `${d.requesterName} (${d.requesterEmail}) at ${ctx.organisationName} has asked you to send files securely using ${ctx.productName}.

Send your files: ${d.link}

To protect the files you will be asked for a one-time code, which we will email to this address when you request it. Only you can use this link.

You can send files until ${when}.

If you were not expecting this request, do not upload anything and contact ${ctx.supportEmail ?? ctx.organisationName}.

${ctx.organisationName}`;
    const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#F5F6F3;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#172C36;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F5F6F3;padding:32px 16px;"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#FFFFFF;border:1px solid #DDE3DF;border-radius:6px;">
<tr><td style="padding:20px 28px;border-bottom:1px solid #DDE3DF;font-size:14px;font-weight:600;color:${esc(ctx.accentColour)};">${esc(ctx.organisationName)} · ${esc(ctx.productName)}</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.55;">
<p><strong>${esc(d.requesterName)}</strong> (${esc(d.requesterEmail)}) has asked you to send files securely.</p>
<p style="margin:24px 0;"><a href="${esc(d.link)}" style="display:inline-block;background:${esc(ctx.accentColour)};color:#FFFFFF;text-decoration:none;padding:12px 20px;border-radius:4px;font-weight:600;">Send your files</a></p>
<p style="font-size:13px;color:#5B6B72;">If the button does not work, copy this link into your browser:<br><span style="word-break:break-all;">${esc(d.link)}</span></p>
<p>You will be asked for a one-time code, emailed to this address when you request it. You can send files until <strong>${esc(when)}</strong>.</p>
<p style="font-size:13px;color:#5B6B72;">If you were not expecting this request, do not upload anything and contact ${esc(ctx.supportEmail ?? ctx.organisationName)}.</p>
</td></tr></table></td></tr></table></body></html>`;
    return { subject, text, html };
  },
};
export type RequestTemplateKey = keyof typeof requestTemplates;
