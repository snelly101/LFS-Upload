# Download semantics

Definitions implemented in `apps/api/src/services/downloads.ts` and surfaced in the UI and audit trail.

## Events
* **Link requested** – an unauthenticated GET of `/r/<token>`. May be a person or a mail-security scanner. Never
  counts as a view.
* **Recipient verified** – a one-time code was consumed. **Authenticated page viewed** – the first `view` call
  within a recipient session. Both are per session; a verified view proves control of the mailbox at that
  time, not the identity of a natural person.
* **Download started / resumed** – a `GET` for file bytes was authorised and a stream began (`resumed` when it
  continues an open attempt).
* **Download completed** – the server streamed every byte of the file for that attempt: the union of served
  byte ranges, merged without double counting, covers `[0, size)`. Not the moment the button was clicked;
  not proof the recipient saved, opened or read the file.
* **Client acknowledged** – optional; the browser reported that its download finished. Recorded separately.
* **Download interrupted** – the socket closed before completion (client disconnect, revocation, expiry).
* **All files downloaded** – per recipient, once every released file has a completed attempt.

## Attempts and allowances
* An **attempt** is one (recipient grant, recipient session, file). Range requests and retries inside the same
  session re-use the open attempt and consume nothing, within abuse bounds (200 requests, 24 h).
* When a per-recipient **download limit** is set, one allowance is consumed when an attempt is created,
  under a row lock on the grant (`UPDATE … WHERE downloads_used < limit`), so concurrent starts cannot
  exceed the limit. A new session (after re-verification) starts a new attempt and consumes a new allowance.
* **Download all (ZIP)** reserves one allowance per file atomically (all or nothing) and marks each file
  completed only if the whole archive stream finished. The ZIP is produced on the fly (store method, ZIP64
  as needed) and cannot be resumed; individual files can.
* Allowances are never refunded automatically; a sender can add a recipient again (fresh grant) if needed.

## Served bytes
`bytes_served` on the attempt counts bytes written to the socket for each request, including overlapping
ranges; coverage (`covered`) is the merged set used for completion. A recipient who downloads the same
range twice therefore shows more bytes served than the file size but exactly one completion.
