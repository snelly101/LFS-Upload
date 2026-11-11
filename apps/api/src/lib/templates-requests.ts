import { formatDateTimeLong } from '@securesend/shared';
import { button, layout, type Rendered, type TemplateContext } from './templates.js';

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
    const html = layout(
      ctx,
      subject,
      `<p style="margin:0 0 14px;"><strong>${esc(d.requesterName)}</strong> (${esc(d.requesterEmail)}) has asked you to send files securely.</p>
       ${button(ctx, d.link, 'Send your files')}
       <p style="margin:14px 0;">To protect the files you will be asked for a one-time code, which we will email to this address when you request it. Only you can use this link.</p>
       <p style="margin:14px 0;">You can send files until <strong>${esc(when)}</strong>.</p>
       <p class="ss-muted" style="font-size:13px;line-height:19px;color:#636B66;">If you were not expecting this request, do not upload anything and contact ${esc(ctx.supportEmail ?? ctx.organisationName)}.</p>`,
    );
    return { subject, text, html };
  },
};
export type RequestTemplateKey = keyof typeof requestTemplates;
