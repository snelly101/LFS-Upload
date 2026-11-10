# File requests (sending files in)

A member of staff can ask named external people to send files to them. This is the reverse of an
ordinary transfer and reuses the same machinery, so the guarantees are the same ones already tested
for downloads. It is not an anonymous upload page.

## How it works

1. Staff create a request: what they are asking for, who should send it, and a closing date within
   the administrator's expiry limit. Each contributor is emailed their own link. The email does not
   contain the title or message.
2. The contributor opens the link and must verify their mailbox with a one-time code, exactly as a
   download recipient does. Verification can never be switched off for a request, whatever the
   recipient-verification policy says, because a bearer link would be an anonymous upload endpoint.
3. After verifying they see who is asking and for what, and can upload files (resumable). Every
   file is quarantined and scanned before anyone can read it.
4. The requester is notified in the app for each file and by email once per contributor, and
   downloads the files from the request page.
5. At the closing date access ends and content is deleted by the same verified deletion job as any
   other transfer. The requester can close the request early (links die, files are kept until the
   closing date) or delete everything immediately.

## Who can do what

| Actor | Can | Cannot |
|---|---|---|
| Contributor (verified) | add files; see the names, sizes and scan result of their **own** uploads | download anything, including their own files; see other contributors or their files |
| Link holder without the mailbox | see a generic "you have been asked to send files" page | learn the title, message, requester or anything else; upload |
| Requester (the member of staff who created it) | download files that passed the scan, until the closing date; add or remove contributors; close; delete | download files that failed or have not finished scanning |
| Other staff, auditors, administrators | see audit metadata within their normal scope | read the content (there is no administrator download) |

## Limits

Contributor uploads count against the **requester's** quota and the organisation quota, and obey the
same limits as staff uploads: the largest file the scanner can check, blocked and allowed file
types, files per transfer, total size per transfer and free-disk headroom. The declared size is
enforced by the upload endpoint. Error messages to contributors do not reveal quota figures.

Administrators can turn the feature off: Administration → Transfer policy → "Allow file requests".

## Implementation map

| Concern | Where |
|---|---|
| Model | `transfers.direction = 'inbound'`, `transfers.closed_at`, `transfer_files.uploaded_by_grant_id` (migration `0004_file_requests.sql`) |
| Create / close / owner download | `apps/api/src/services/requests.ts`, `apps/api/src/routes/requests.ts` |
| Contributor upload endpoint | tus at `/api/r/:token/tus`, authorised by the recipient session bound to that token (`routes/requests.ts`) |
| Contributor view | `inboundView()`; recipient download and ZIP routes return 404 for inbound transfers (`routes/recipient.ts`) |
| Staff upload endpoint isolation | `/api/uploads/tus` refuses inbound upload ids (`routes/uploads.ts`) |
| Notification to requester | `scanFile()` in `apps/api/src/worker/handlers.ts` |
| Tests | `apps/api/src/test/20-file-requests.test.ts` |

## Audit events

`request.created`, `invitation.queued` (purpose upload), `recipient.verified`,
`inbound.file_registered`, `upload.started`, `upload.completed`, `scan.passed` / `scan.blocked` /
`scan.failed`, `inbound.downloaded_by_owner`, `request.closed`, then the usual `transfer.expired`,
`deletion.*`.

## Residual risks

* A verified contributor can upload unwanted or unlawful material. Mitigations: named recipients
  only, scanning, quotas, short closing dates, full audit, and the requester's ability to delete
  immediately. Staff should only request files from people they have a reason to hear from.
* Malware scanning is heuristic. Staff open received files on their own managed devices, which need
  their own endpoint protection.
* Content from outside is stored on the same encrypted volume as outbound content and is deleted on
  the same schedule; the same limits of volume encryption apply (see THREAT-MODEL.md).
