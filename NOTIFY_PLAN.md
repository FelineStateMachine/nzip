# Notify feature plan

Status: implemented and deployed in staged mode. Pairing and subscription setup are available;
delivery remains disabled until the owner completes the explicit real-device go/no-go checks.

This document is written for adversarial review. It tries to make the trust boundaries, implicit
assumptions, failure semantics, and uncomfortable product questions explicit. A reviewer should
challenge those claims before approving implementation.

## Proposed outcome

`nzip notify` sends a user-visible Web Push notification from the authenticated CLI, through the
nzip Worker, to one or more mobile devices that the deployment owner explicitly approved.

The root URL is the installation and notification origin. It does not become a general account or
device-management dashboard. The centered nzip wordmark remains the page's dominant element. Setup
is exposed as quiet footer text beside the existing `args` link, with no cards, forms, large
buttons, or persistent status panel.

The desired sequence is:

```text
browser enrollment
  -> owner CLI approval
  -> browser installation nudge
  -> installed app notification permission
  -> PushSubscription attachment
  -> active notification device
```

Approval always precedes installation promotion and subscription attachment. Manual installation
cannot be prevented on every browser, but an unapproved installation must never be able to attach a
subscription or receive a push.

## Review targets

The most important claims to attack are:

1. WebKit copies an HTTP-only claim cookie into an installed web app and sends a `SameSite=Lax`
   cookie on the Home Screen launch navigation. Both details are slice-0 go/no-go checks, not
   settled assumptions.
2. Owner approval before subscription attachment actually prevents unauthorized notification
   recipients.
3. A public browser-supplied push endpoint can be validated tightly enough to avoid turning the
   Worker into an arbitrary outbound request primitive.
4. D1 plus `waitUntil()` and scheduled retries is durable enough for the intended personal-device
   scale without Cloudflare Queues.
5. The existing deployment-wide bearer token is the right authority to send arbitrary
   lock-screen-visible text.
6. Same-origin notification click targets are sufficient; arbitrary URLs are intentionally excluded.

## Adversarial review resolutions

The first adversarial review found six blockers and nine secondary gaps. This revision resolves or
turns each into an explicit slice-0 gate:

| Finding                               | Resolution in this revision                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve-by-code contradiction         | Preview and approve are code-addressed; the server hashes the presented code and pairing-code hashes are unique.                               |
| Partially verified iOS cookie handoff | Use `SameSite=Lax`; test HTTP-only copy and Home Screen cookie sending as separate go/no-go checks.                                            |
| Claim rotation race                   | Do not rotate the secret; use an idempotent activation POST that extends the same cookie only after approval.                                  |
| Undefined renewal and recovery        | Renew near expiry on validated installed-app use; test push-handler renewal; document remove-and-reinstall recovery.                           |
| Concurrent double-send                | Add conditional D1 delivery leases shared by immediate and cron drains.                                                                        |
| Incomplete Worker SSRF model          | Make an operator-configured provider hostname allowlist the real control; fail closed and forbid redirects/own-zone endpoints.                 |
| Approval lacks context                | Preview bounded creation, device, user-agent, country/region, and ASN metadata before confirmation.                                            |
| Root caching risk                     | Keep `/` a claim-independent static shell; make every claim-sensitive response `no-store`.                                                     |
| Endpoint uniqueness ambiguity         | Same-row attach is idempotent; a new approved row atomically steals the endpoint and disables the old row.                                     |
| HTTP-only UI assumption               | Resolve authority through a credentialed state request; disable controls until online validation.                                              |
| Silent subscription death             | Revalidate and re-attach on every standalone launch; expose last success in the CLI.                                                           |
| VAPID and D1-secret policy            | Document rotation as subscription-breaking; skip application-layer D1 encryption in v1 while treating fields as secrets.                       |
| Android install assumption            | State install-first as a product choice and test browser-tab push separately.                                                                  |
| Reusable address click risk           | Pin site notifications to the sent manifest and validate before opening.                                                                       |
| Smaller operational gaps              | Set a 32-row pending cap, polling cadence, due index, enable flag, consistent routes, ordinary-path test event, and slice-0 iOS wording check. |

## Goals

- Allow a bearer-authenticated CLI to submit a small notification event.
- Deliver that event to every active owner-approved device.
- Keep the nzip bearer token out of all browser and PWA storage.
- Use the browser or operating system installation surface wherever it is programmatically
  available.
- Delay all installation promotion until the device enrollment is approved.
- Require a separate user gesture for notification permission.
- Route notification clicks to `/` or to an existing same-origin nzip site.
- Persist enough delivery state to retry transient failures and diagnose loss.
- Remain appropriate for a small, single-user, free-tier-oriented deployment.

## Non-goals

- User accounts, teams, or multiple owners.
- Public visitor subscriptions.
- Per-vault recipients or notification groups.
- Arbitrary external notification click URLs.
- Silent pushes or background data synchronization.
- Exactly-once delivery.
- Guaranteed real-time delivery while a device is offline or suppressing alerts.
- Replacing the existing security-alert email pipeline.
- A full notification inbox synchronized across devices.
- iOS or iPadOS versions older than 17.2.

## Existing constraints

- nzip is single-user by design and uses one deployment-wide bearer token.
- Every `/api/*` request currently passes through the bearer check before API routing.
- `/` is public and currently serves a static landing page.
- The Worker already uses D1 outbox state plus immediate and scheduled delivery attempts for
  security email.
- CLI and shared-code changes must remain Deno-first.
- Worker changes use the existing TypeScript, Wrangler, and Vitest setup.

## Visual contract

The setup surface extends the current landing page instead of replacing its composition:

```text
                         nzip


                    args · pair
```

Visual rules:

- Preserve the current warm background, centered wordmark, coral `z`, monospace type, and muted
  footer treatment.
- Put pairing state immediately beside `args` in the footer.
- Use exactly `pair` before approval and `paired` after approval.
- `pair` is a text action. `paired` is state, not a device-management link.
- Do not show a pairing code, device name, notification status, or installation instruction until it
  is relevant.
- Do not add a custom installation button. The browser or operating system owns installation UI.
- In the installed app, expose one additional text action: `notifications off` or
  `notifications on`.
- The notification text is the only notification control. There are no separate enable, disable,
  test, settings, or retry buttons on `/`.
- Keep operational device naming, listing, testing, and revocation in the CLI.
- Use color and underlining sparingly. Actions may use the existing footer-link treatment; completed
  state should be quieter than an action.
- Avoid icons, switches, checkboxes, badges, illustrations, modal dialogs, and platform logos.
- Implement `pair` and the notification toggle as semantic `<button>` elements visually reset to
  match the existing `args` link. Keep `paired` as a non-interactive `<span>`.
- Preserve visible keyboard focus even though the controls are visually quiet.
- Put transient code, instruction, and error text in one centered `aria-live="polite"` region so a
  state change does not rearrange the wordmark or footer.
- Use the existing 12px muted footer type for controls and status. The pairing code may be slightly
  brighter with modest letter spacing, but it must remain secondary to the wordmark.

### Visual states

Unpaired, collapsed:

```text
                         nzip


                    args · pair
```

`pair` is the only setup action. The server does not create an enrollment merely because somebody
visited `/`.

Pairing, expanded after tapping `pair`:

```text
                         nzip

                       ABCD-1234
                        waiting

                    args · pair
```

The code and `waiting` label are small, muted, and centered beneath the wordmark. They exist only
after the visitor deliberately taps `pair`. A refresh with a live claim may restore this expanded
state; a new visitor sees the collapsed state.

Approved in a regular Android browser:

```text
                         nzip


                   args · paired
```

Attaching the manifest and service worker after approval lets the browser expose its native ambient
install affordance. The page does not add an install control.

Approved in an iPhone browser:

```text
                         nzip

               share → add to home screen

                   args · paired
```

The instruction is muted and disappears when running in standalone mode. Whether iOS 26 needs an
additional `Open as Web App` hint is a slice-0 observation; do not ship unverified wording.

Installed, notifications inactive:

```text
                         nzip


       args · paired · notifications off
```

Because pairing authority lives in an HTTP-only cookie, an installed launch begins with `args · …`
while the credentialed state request is pending. The actionable footer appears only after online
validation. Offline last-known state may be rendered muted, but never as an enabled control.

Installed, notifications active:

```text
                         nzip


       args · paired · notifications on
```

`notifications off` and `notifications on` are the same text control in two states. The labels
describe current state; tapping them requests the opposite state.

During an operation, replace the state briefly with `notifications …` and disable repeat taps. On a
recoverable error, restore the previous state and show one muted line beneath the wordmark. If the
browser permission is denied, show non-actionable `notifications blocked`; the page cannot revoke or
open operating-system permission settings on the user's behalf.

## User journey

### 1. Begin enrollment

The owner opens `/` on the intended mobile device. The page initially shows only the wordmark and
the footer `args · pair`. No enrollment exists yet.

The owner taps `pair`. That deliberate action expands the pairing state and calls:

```http
POST /_notify/enrollments
```

The Worker creates a pending device record and returns a display-safe pairing code. Pairing-code
hashes are unique. Creation generates a new code and retries on a uniqueness conflict, so approval
can never match more than one pending row. It also sets a high-entropy claim cookie:

```text
HttpOnly
Secure
SameSite=Lax
Path=/
Max-Age=600
```

The pending and approved states use the same high-entropy claim value. The server changes the row's
authority, not its secret, so two tabs cannot invalidate one another by racing a credential
rotation.

The page adds only the code and a quiet waiting label beneath the wordmark:

```text
ABCD-1234
waiting
```

The page polls its own state using the claim cookie. It polls every three seconds for the first
minute, then every ten seconds with jitter. The setup read limiter allows at least 30 reads per
claim per minute, so legitimate polling stays below its threshold. The pairing code is not an
authentication credential; possession of the owner bearer token is required to approve it.

### 2. Approve from the CLI

The owner runs:

```text
nzip notify approve ABCD-1234 --name "Personal iPhone"
```

The CLI first requests an authenticated approval preview by code:

```http
GET /api/notify/approvals/ABCD-1234
Authorization: Bearer <owner token>
```

It displays the enrollment creation time, bounded user-agent summary, device class, country/region,
and ASN before asking the owner to confirm. Raw IP addresses are neither stored nor displayed. After
confirmation, the CLI calls the code-addressed approval endpoint:

```http
POST /api/notify/approvals
Content-Type: application/json
Authorization: Bearer <owner token>

{"code":"ABCD-1234","name":"Personal iPhone"}
```

The server normalizes and hashes the presented code, then changes the one matching, unexpired device
from `pending` to `approved`. A missing, expired, already-used, or otherwise unmatched code returns
the same generic error. Approval does not yet create an active notification recipient because no
push subscription exists.

### 3. Promote installation only after approval

The waiting page observes the approved state, then explicitly calls:

```http
POST /_notify/enrollments/activate
Cookie: <pending claim>
```

Activation is idempotent: it validates the same claim verifier, confirms that the row is approved,
and reissues the same cookie value with a one-year lifetime. Only after that response succeeds does
the page remove the pairing code, change `pair` to `paired`, attach the web app manifest, and
register the service worker. The UI tells the user to remain on this page until `paired` appears.
Installing before activation may snapshot the ten-minute pending cookie and require the app to be
removed and installed again if that cookie expires.

Android Chromium behavior:

- Rely on the browser's ambient install affordance after the site becomes installable.
- Do not capture `beforeinstallprompt` in order to build a custom install button.
- Do not attempt to call `prompt()` automatically; the approval poll is not a user gesture.
- If the browser provides no ambient affordance, show one muted fallback line such as
  `add to home screen from the browser menu`.

iPhone and iPad behavior:

- There is no web API that opens the Add to Home Screen flow.
- After approval, show the minimal instruction: `Share -> Add to Home Screen`.
- Add any iOS 26 `Open as Web App` wording only if slice 0 confirms the actual installation UI.
- Do not present these instructions before approval.

Desktop and unsupported browsers may show equivalent platform guidance, but mobile Android and
iPhone are the v1 acceptance targets.

### 4. Carry approval into the installed app

The claim is stored in an HTTP-only cookie, not local storage. WebKit documents a one-time copy of
browser cookies into a newly installed Home Screen web app from any iOS browser, while other local
storage is not copied. The documentation does not explicitly guarantee that the copy includes
HTTP-only cookies or that the resulting Home Screen launch sends a `SameSite=Lax` cookie. Slice 0
must prove both. The manifest keeps a stable `id: "/"` and does not put a device identifier or claim
secret into `start_url`.

The minimum supported Apple mobile release is iOS/iPadOS 17.2. There is no older-version fallback,
continuation-code flow, or identifier-bearing `start_url`. When an older release can be identified,
the setup surface shows one muted `requires iOS 17.2+` line and does not create an enrollment.
Embedding a unique device claim in `start_url` remains rejected because it is a persistent
identifier and the Web App Manifest specification calls out that privacy risk.

### 5. Attach a push subscription

The installed app cannot read the HTTP-only cookie. On every standalone launch it performs a
credentialed `GET /_notify/enrollments/current`; only the server response can authorize the paired
footer and subscription controls. Until that request resolves, the footer shows `args · …`. If the
app is offline, it may show last-known local presentation state, but the notification control stays
disabled until the server confirms the claim. Once confirmed, the footer becomes:

```text
args · paired · notifications off
```

Tapping `notifications off` supplies the required user gesture. The app requests notification
permission, obtains a `PushSubscription` using the deployment VAPID public key, and calls:

```http
POST /_notify/subscriptions
Content-Type: application/json
Cookie: <approved device claim>

{
  "endpoint": "https://push-service.example/...",
  "expirationTime": null,
  "keys": {
    "p256dh": "...",
    "auth": "..."
  }
}
```

The server validates the endpoint and keys, attaches them to the already-approved device, and
changes its state to `active`. The footer becomes `args · paired · notifications on`.

On every later standalone launch, the app reads `pushManager.getSubscription()` and re-attaches it
through the same endpoint. Identical endpoint and key material is an idempotent no-op that updates
`last_seen_at` without consuming a full subscription write; changed material replaces the previous
subscription. Do not depend on `pushsubscriptionchange`, which may be absent or unreliable.

Tapping `notifications on` unsubscribes the browser, removes the subscription capability from the
server, and returns the device to approved-but-inactive state. It does not revoke owner approval and
does not attempt to revoke the browser's notification permission. The owner can turn notifications
back on without pairing again while the approved claim remains valid.

The service worker must display a user-visible notification for every push. It must not use pushes
for silent work.

### 6. Send a notification

Primary CLI shape:

```text
nzip notify <body> [--title TEXT] [--open TARGET] [--tag TEXT]
```

Examples:

```text
nzip notify "Your report is ready"
nzip notify "Your report is ready" --title Codex --open work:report
nzip notify "Build completed" --tag build-main
```

If `--open` is present, the CLI resolves the existing nzip target, applies the local vault guard,
and sends only the resolved same-origin path such as `/12d8`. The API never accepts an arbitrary
absolute click URL.

The CLI calls:

```http
POST /api/notify
Content-Type: application/json
Authorization: Bearer <owner token>

{
  "title": "Codex",
  "body": "Your report is ready",
  "path": "/12d8",
  "tag": "report-ready"
}
```

The response reports acceptance, not delivery:

```json
{
  "eventId": "01J...",
  "queuedDevices": 2,
  "inactiveDevices": 1
}
```

Human output:

```text
notification queued for 2 devices (event 01J...)
```

## Device state machine

```text
                   owner approval
pending --------------------------------> approved
   |                                         |
   | pairing expiry                          | subscription attached
   v                                         v
expired                                   active
                                              |  |
                    user toggles notifications|  |push endpoint 404/410
                    off                       |  +--------------------> disabled
                                              |
                                              +----------------------> approved

Any non-revoked state ---------------- owner revoke ----------------> revoked
```

Proposed rules:

- `pending`: has a claim and pairing code; cannot be installed through nzip's promoted flow and
  cannot attach a subscription.
- `approved`: owner-authorized claim; may see installation UI and attach one subscription.
- `active`: approved and has a currently usable subscription.
- An active device returns to `approved` when the user toggles notifications off. Approval and the
  claim remain; subscription capability material is deleted.
- `disabled`: endpoint is known to be expired or rejected; key material is removed and re-enrollment
  is required.
- `revoked`: owner explicitly removed access; key material and claim verifier are removed
  immediately.
- `expired`: unapproved or incomplete setup exceeded its allowed lifetime.

Proposed lifetimes:

- Pending approval: 10 minutes.
- Approved, never activated setup: 24 hours to complete the initial installation and subscription.
- Approved, previously active but toggled off: remains paired until owner revocation or approved
  claim expiry.
- Active: no fixed expiry; browser endpoint responses and owner action control its lifetime.
- Revoked and expired tombstones: retain only if needed for a short audit window.

Enrollment storage is bounded to 32 unexpired pending rows deployment-wide. Before creating a row,
the Worker prunes expired pending rows. If 32 remain, it rejects the new enrollment with a bounded
`Retry-After`; it never evicts an unexpired enrollment, because attacker-driven eviction would make
the cap another denial-of-service primitive. Enrollment creation also has a stricter per-IP limiter
than claim-authenticated polling.

An active PWA may refresh changed subscription material without new owner approval while presenting
the same approved claim. This decision is closed: revalidation on every standalone launch is the
primary defense against silent subscription death.

Approved claims use a one-year sliding expiry. A credentialed `POST /_notify/enrollments/renew`
extends the server expiry and cookie only when fewer than 90 days remain, avoiding a D1 write on
every launch. The installed app calls it after a successful launch validation. Slice 0 must also
test whether a service worker can renew from a credentialed fetch while handling a visible push; use
that as an additional renewal path only if verified.

If the installed app loses or expires its claim, re-pairing in the browser cannot copy new state
into an already-installed app. Recovery is explicitly destructive: remove the Home Screen app, pair
in the browser again, wait for `paired`, and install it again.

## HTTP surface

Public but claim-cookie authenticated:

```text
POST   /_notify/enrollments             create a pending enrollment
GET    /_notify/enrollments/current     poll or validate the caller's enrollment
POST   /_notify/enrollments/activate    extend an approved pending claim before installation
POST   /_notify/enrollments/renew       renew a validated installed-app claim near expiry
POST   /_notify/subscriptions           attach or refresh a subscription after approval
DELETE /_notify/subscriptions/current   toggle notifications off while preserving approval
POST   /_notify/click-target            validate an event target before navigation
GET    /_notify/vapid-public-key        retrieve the application-server public key
```

Owner bearer authenticated:

```text
POST   /api/notify                    enqueue an event
GET    /api/notify/devices            list pending and active devices
GET    /api/notify/approvals/{code}   preview a pending enrollment by code
POST   /api/notify/approvals          approve by hashing the presented code
DELETE /api/notify/devices/{id}       revoke a device
```

The route-prefix decision is closed: keep the claim-authenticated surface under `/_notify/*`. It
cannot collide with four-hex site addresses and avoids weakening the global bearer boundary on
`/api/*`.

There is no special `/api/notify/test` route. `nzip notify test` submits a recognizable diagnostic
event through the ordinary `POST /api/notify` contract so the smoke test exercises the real path.

All public mutation endpoints require explicit content types, bounded bodies, strict schemas, no
CORS, same-origin fetch metadata where available, and rate limits distinct from address enumeration
and unlock limits.

### Root caching boundary

Keep `/` as a claim-independent static shell so it may retain public caching. It must not render
`pair` versus `paired` on the server, inspect cookies, set cookies, or embed pairing state. Client
JavaScript obtains state only from `/_notify/enrollments/current` and mutates the footer locally.

Every `/_notify/*` response is `Cache-Control: no-store`; claim-sensitive reads also send
`Vary: Cookie`. No cacheable response may contain `Set-Cookie`. This prevents a paired footer or
claim cookie from being replayed to another visitor while preserving the cheap static root.

## Event contract

Proposed shared types:

```ts
export interface NotifyRequest {
  title?: string;
  body: string;
  path?: string;
  tag?: string;
}

export interface NotifyResponse {
  eventId: string;
  queuedDevices: number;
  inactiveDevices: number;
}
```

Validation:

- `title`: defaults to `nzip`; 1-80 Unicode scalar values.
- `body`: required; 1-240 Unicode scalar values.
- `path`: omitted or a normalized same-origin absolute path beginning with `/`.
- `path`: reject schemes, protocol-relative values, backslashes, credentials, control characters,
  and encoded forms that normalize outside the origin.
- `tag`: optional; 1-64 characters from a conservative ASCII set.
- Entire serialized notification payload: capped below the smallest supported browser push payload
  after encryption overhead. The exact cap must be set by the transport spike rather than assumed
  here.

Notification content is visible on lock screens. CLI help and documentation must explicitly say not
to put passwords, tokens, private URLs, or sensitive personal data in title or body.

## Persistence model

Keep owner notifications separate from security email notifications.

Illustrative schema, not final migration SQL:

```sql
CREATE TABLE notification_devices (
  id TEXT PRIMARY KEY,
  pairing_code_hash TEXT UNIQUE,
  claim_hash TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL,
  user_agent_summary TEXT,
  device_class TEXT,
  country TEXT,
  region TEXT,
  asn INTEGER,
  endpoint TEXT,
  endpoint_hash TEXT,
  p256dh TEXT,
  auth TEXT,
  created_at INTEGER NOT NULL,
  pairing_expires_at INTEGER,
  claim_expires_at INTEGER,
  approved_at INTEGER,
  active_at INTEGER,
  last_attached_at INTEGER,
  last_seen_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  UNIQUE(endpoint_hash)
);

CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  path TEXT,
  expected_manifest_hash TEXT,
  tag TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE notification_deliveries (
  event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  lease_owner TEXT,
  lease_expires_at INTEGER,
  sent_at INTEGER,
  last_error TEXT,
  PRIMARY KEY (event_id, device_id)
);

CREATE INDEX idx_notification_deliveries_due
  ON notification_deliveries(status, next_attempt_at);
```

Do not store the raw claim cookie. Store a keyed digest or cryptographic hash and compare a digest
of the presented value. Pairing codes are short-lived and must also be stored as non-reversible
verifiers.

Endpoint, `p256dh`, and `auth` are capability secrets and must be protected from logs and API
responses. The application-layer-encryption decision is closed for v1: do not add it. In this
single-tenant Worker, the same deployment would hold the decryption key, so encryption mainly
reduces D1-snapshot-only disclosure while adding secret rotation and recovery failure modes. Revisit
if the storage or tenancy model changes.

Endpoint uniqueness uses steal-and-disable semantics. Attaching an endpoint already owned by the
same row is idempotent. Attaching it from a different approved row atomically disables the old row,
clears its capability material, and assigns the endpoint to the new row. A constraint conflict must
never surface as a generic 500.

## Architectural reference: Pushy

[Pushy](https://codakuma.com/pushy/) is a useful small-scale, Cloudflare-free-tier-focused
reference. Its author describes an approximately 200-line Worker that stores native iOS device
tokens in KV, registers and deregisters tokens through two endpoints, signs APNs requests with
Worker crypto, sends directly to APNs, and deletes tokens when APNs returns `410`. The native client
avoids redundant registration writes so steady-state KV usage stays low.

Transferable lessons for nzip:

- Direct delivery from a Worker to the platform push service is viable for a small personal service;
  an intermediary such as OneSignal is not inherently required.
- Registration and opt-out should be symmetric. Nzip's `notifications off` action should delete
  subscription capability rather than leave an inactive endpoint stored indefinitely.
- Provider `410` responses should automatically remove stale subscription capability.
- Clients should compare the current subscription with the last attached subscription and avoid a D1
  write when nothing changed.
- The system should be intentionally small enough that its full delivery path can be audited.
- Free-tier cost discipline belongs in the design: initial enrollment bursts, redundant writes, and
  fan-out reads deserve explicit tests and metrics.

Important differences:

- Pushy targets native APNs. Nzip targets standards-based Web Push across browser vendors, so it
  needs VAPID plus encrypted payload construction using the subscription's `endpoint`, `p256dh`, and
  `auth` values. Pushy's APNs JWT transport cannot be reused directly.
- Pushy trusts an application key for token registration. Nzip requires a pending browser claim and
  explicit owner approval before a subscription may be attached.
- Pushy uses KV and reads the token set for a send. Nzip already uses D1 and needs relational device
  state, atomic event/delivery creation, retry scheduling, and revocation checks; D1 remains the
  proposed store.
- Pushy's admin HTML sends messages. Nzip deliberately keeps composition in the authenticated CLI
  and keeps `/` visually limited to pairing and notification state.
- The article describes the implementation but does not provide source code to audit. Treat it as
  architectural evidence and a simplicity benchmark, not as a dependency or security reference.

The transport spike should use Pushy's approximate scale as a challenge: explain every additional
nzip component and remove it if owner approval, cross-browser Web Push, or durable retry semantics
do not require it.

## Push transport

The transport must implement standard Web Push payload encryption and VAPID authentication.
Cloudflare Workers exposes the required ECDH, ECDSA, HKDF, and AES-GCM Web Crypto operations and
supports outbound `fetch()`.

Implementation policy:

- Put protocol work behind a narrow `WebPushTransport` interface.
- Prefer a small, maintained, standards-conformant library that demonstrably executes in Workers.
- Do not copy a hand-rolled cryptographic implementation directly into route code.
- If no suitable library works, isolate the minimal RFC implementation and test it against
  independent fixtures and real browser endpoints.
- Generate one VAPID key pair per deployment.
- Store the VAPID private key as a Worker secret.
- Expose only the VAPID public key to the root app.
- Use a stable `sub` contact claim configured by the deployment operator.
- Treat VAPID key rotation as a subscription-breaking operation. Rotation marks every active device
  `disabled` and requires each still-approved installed app to recreate its subscription through the
  notification toggle or launch revalidation. Launch revalidation compares
  `subscription.options.applicationServerKey` with the current public key; on mismatch it
  unsubscribes and creates a new subscription. A valid approved claim avoids owner re-pairing.
- Do not treat VAPID application-server-key binding as a substitute for protecting endpoint,
  `p256dh`, and `auth` capability material.

The transport spike must prove delivery to, at minimum:

- Current Chrome on Android.
- A Home Screen web app on current iOS Safari/WebKit.
- A closed app with the browser not foregrounded.
- A notification containing Unicode and a same-origin click path.

## Delivery and retry semantics

When `POST /api/notify` succeeds:

1. Validate the event.
2. Read active devices.
3. Insert one event and one pending delivery per active device in a D1 batch.
4. Start an immediate drain with `ctx.waitUntil()`.
5. Return acceptance without waiting for device delivery.

Immediate and scheduled drains share the same lease protocol. A drain first reads due candidates,
then conditionally claims each row:

```sql
UPDATE notification_deliveries
SET status = 'sending', lease_owner = ?, lease_expires_at = ?
WHERE event_id = ? AND device_id = ?
  AND (
    (status IN ('pending', 'retry') AND COALESCE(next_attempt_at, 0) <= ?)
    OR (status = 'sending' AND lease_expires_at < ?)
  );
```

It sends only when the update reports exactly one changed row. The lease owner is a random drain ID;
the lease is long enough for the provider timeout and short enough for crash recovery. Terminal or
retry updates include `WHERE status = 'sending' AND lease_owner = ?` so an expired worker cannot
overwrite a newer claimant. This conditional-update lease is required because D1 has no
`SELECT FOR UPDATE` and the immediate drain can overlap the five-minute cron.

Delivery outcomes:

- `2xx`: mark sent.
- `404` or `410`: disable device, erase subscription key material, do not retry.
- `429`: honor bounded `Retry-After`, then retry.
- Other `4xx`: record a permanent failure unless the transport specification identifies a retryable
  case.
- Network error or `5xx`: schedule bounded exponential retry.

The existing five-minute scheduled handler may invoke the new notification drainer. The security
email outbox is precedent for durable payload state, but notify's lease-aware general drainer is new
machinery rather than reuse of the current email drain.

Proposed retry policy:

- Immediate attempt.
- Then approximately 5, 15, 60, and 360 minutes, quantized to the five-minute cron.
- Maximum five attempts over about six hours.
- Add jitter so multiple devices do not retry in lockstep.

The system provides at-least-once transport attempts, not exactly-once visible notifications.
Browser behavior and timeouts can make a send result ambiguous. The notification `tag` should be
used when replacement/deduplication semantics matter to the caller.

The Cloudflare Queues decision is closed for v1: use the D1 outbox with conditional leases for the
expected handful of owner devices. Add Queues only if measured fan-out, retry volume, or latency
outgrows the scheduled outbox.

## Notification click routing

Four-character addresses are reusable after site deletion or expiry. An old notification must not
blindly open a newly allocated site at the same path. For `--open` events, the CLI records both the
resolved path and the site's current manifest hash. The root-scoped service worker handles
`notificationclick`:

1. Close the notification.
2. For a generic event, focus or open `/`.
3. For a site event, send the event ID to credentialed `POST /_notify/click-target`.
4. The Worker loads the retained event and current site. It returns the path only when the current
   manifest still equals `expected_manifest_hash`.
5. Focus an existing matching client or call `clients.openWindow(path)` only after validation.
6. If the event expired, the site disappeared, the address was reused, or the manifest changed, open
   `/` with a transient `link expired` state instead of opening potentially unrelated content.

The service worker remains the notification router. No event token appears in the browser URL. This
v1 contract intentionally pins a notification to the manifest that existed when it was sent; a later
re-push makes the old click target expire rather than silently opening changed content.

## Platform-specific installation behavior

### Android

The `beforeinstallprompt` API is Chromium-specific and not guaranteed to fire. This design does not
turn it into a custom `Install` control. Approval makes the site installable and lets the browser
present its own ambient installation surface. Therefore approval can unlock native install
promotion, but it cannot force installation or guarantee that a prompt appears.

Install-first behavior on Android is a product consistency requirement, not an assumed platform
requirement. Chrome may support Web Push without Home Screen installation. Slice 0 must test that
capability, but v1 still withholds the notification toggle outside standalone mode so Android and
iPhone share one owner setup model unless the product decision is revisited.

Adversarial cases:

- Approval arrives before the browser reevaluates installability.
- Browser heuristics suppress the event.
- The app is already installed.
- The user dismisses or ignores the browser's affordance.
- A non-Chromium Android browser provides only manual installation.

The page must handle all of these without treating missing install telemetry as an authorization
failure.

### iPhone and iPad

Websites cannot programmatically open Add to Home Screen. The approved browser page can only explain
the native action. Web Push remains tied to a Home Screen web app and notification permission
requires a user gesture.

Cookies are copied into a new Home Screen web app on iOS/iPadOS 17.2 and later; other local storage
is not copied. That is why the approved claim uses a cookie.

Adversarial cases:

- The user adds the site before approval.
- The user disables `Open as Web App` on iOS 26.
- The browser does not copy the cookie due to version or privacy behavior.
- The user opens the browser tab rather than the Home Screen app.
- The user installs multiple copies of the same manifest identity.
- The user clears browser or app data after approval.

Only an approved claim may attach a subscription. One approved device row owns one current endpoint.
If multiple installed copies share the copied claim, the most recent successful attachment wins and
the previous endpoint is removed; the older installation silently stops receiving. Owners who need
two independently active installations must pair them as two devices. Slice 0 must verify how iOS
and Android actually represent multiple installs and whether this limitation is acceptable.

### Notification toggle semantics

The footer toggle controls nzip subscription state, not operating-system permission:

- `notifications off` -> request permission if needed, subscribe, attach, become active.
- `notifications on` -> call `unsubscribe()`, remove endpoint and keys, return to approved.
- `notifications blocked` -> permission is denied; render as non-actionable state.
- `notifications …` -> an operation is in flight; ignore repeat activation.

The toggle is visible only in standalone display mode with an approved claim. A normal browser tab
never exposes it, even after approval. Device testing and revocation remain CLI actions.

## Threat model

| Threat                                            | Proposed control                                                                       | Residual concern                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Attacker enrolls many pending devices             | Dedicated IP rate limit, ten-minute expiry, hard cap of 32 live pending rows           | Distributed abuse can deny pairing for up to the expiry window     |
| Attacker guesses a pairing code                   | Pairing code cannot approve itself; bearer is still required                           | Public status lookup must also require claim cookie                |
| Stolen pairing URL or cookie before approval      | Short lifetime, Lax HTTP-only cookie, owner preview of bounded device/network metadata | Browser compromise and social approval attacks remain possible     |
| Unapproved PWA calls subscription endpoint        | Server requires an approved claim verifier                                             | Manual installation is allowed but inert                           |
| Forged subscription endpoint causes SSRF          | Operator-configured push-service hostname allowlist; HTTPS and URL parser hygiene      | Push-service origins evolve; configuration maintenance is required |
| Push endpoint leaks through logs                  | Never log raw endpoint, keys, claim, or payload body                                   | Provider hostname may still be useful telemetry                    |
| Bearer holder sends abusive text                  | Existing bearer is owner authority; no misleading local-only security guard            | No server-side sender scopes exist                                 |
| Notification opens phishing URL                   | Relative same-origin paths only                                                        | Hosted content itself can still be misleading                      |
| Revoked endpoint remains deliverable              | Delete key material and exclude non-active status atomically                           | An in-flight request may already have left the Worker              |
| Duplicate visible notifications                   | Conditional D1 delivery lease plus optional notification tag                           | Provider timeout can still leave delivery outcome ambiguous        |
| D1 write succeeds but immediate send never starts | Scheduled outbox drain                                                                 | Retry latency can be up to the cron interval                       |
| D1 compromise reveals subscriptions               | Minimize retention and treat fields as secrets; no application-layer encryption in v1  | D1-snapshot-only disclosure is accepted                            |

### Push endpoint validation

This is a release-blocking security decision.

A browser subscription endpoint is supplied by an untrusted client. Approval of the browser session
does not cryptographically prove that the submitted URL is a real push-service endpoint. Blindly
fetching it would create an owner-approved but attacker-controlled outbound request primitive.

At minimum:

- Require HTTPS.
- Reject credentials, fragments, non-default parsing oddities, IP literals, and syntactically
  private or link-local address forms as parser hygiene.
- Treat an explicit push-service hostname allowlist as the actual request-forgery control. Workers
  cannot perform a trustworthy resolve-then-fetch DNS check, and hostname tricks cannot be made safe
  by private-range checks alone.
- Store the allowlist in operator-updatable `WEB_PUSH_ORIGINS` configuration, parsed and validated
  at startup. A provider change must not require a source patch, but invalid or empty production
  configuration must fail closed.
- Validate before persistence and again before every fetch.
- Add unit tests for alternate IP encodings, redirects, DNS-shaped hostnames, Unicode hostnames, and
  URL parser differentials.
- Do not follow redirects in v1.
- Never allow the deployment's own hostname; fetching it can re-enter the Worker and burn
  subrequests or create loops.

Slice 0 must validate a starting policy against actual subscriptions. Candidate hosts from the
adversarial review are `fcm.googleapis.com`, `web.push.apple.com`,
`updates.push.services.mozilla.com`, and the required subdomains of `notify.windows.com`. Do not
merge delivery code with an `allow any HTTPS URL` fallback. The practical threat is request forgery,
third-party quota burn, and Worker re-entry rather than access to a conventional VPS private
network.

## Sender authority and local guardrails

In the current model, possession of the deployment bearer token authorizes an owner-wide
notification. There is no server-side distinction between a human CLI, an unrestricted agent, and an
agent whose local config limits vaults.

`--open TARGET` must apply the existing `allowVaults` checks before resolution. That prevents a
restricted CLI from constructing a click-through into a vault it cannot otherwise target.

The sender-guard decision is closed: do not add `allowNotify` in v1. The deployment bearer already
represents full owner authority, and a local flag is not a security boundary against code that can
read that token. Real sender restriction requires scoped server credentials, which is a separate
authentication feature. Document this authority plainly.

## Privacy and retention

- Notification bodies are stored long enough for delivery retries and diagnosis.
- Proposed event and delivery retention: seven days after terminal state.
- Pending enrollments expire after ten minutes.
- Approved enrollments that have never completed an initial subscription expire after 24 hours.
- Revocation immediately removes endpoint, `p256dh`, `auth`, and claim verifier.
- Never log notification body, endpoint, push keys, claim cookie, or pairing-code verifier.
- Structured logs may include event ID, device ID, provider class, attempt count, result class,
  duration, and retry time.
- Device names are owner-provided and may contain personal information; avoid emitting them in
  routine Worker logs.

## Observability

Suggested structured events:

```text
notify.enrollment_created
notify.device_approved
notify.subscription_attached
notify.event_accepted
notify.delivery_sent
notify.delivery_retry
notify.delivery_disabled
notify.device_revoked
notify.setup_expired
```

Every delivery log should include stable IDs but no content or subscription secrets. Metrics worth
exposing through logs or D1 queries:

- Pending, approved, active, disabled device counts.
- Events accepted.
- Deliveries sent, retried, permanently failed, or disabled.
- Time from event acceptance to successful provider response.
- Setup abandonment between approval and subscription attachment.
- Provider response classes.

`nzip notify devices` must show status, creation/approval times, `last_seen_at`, `last_attached_at`,
`last_success_at`, and the most recent bounded error class. This is the owner's primary way to
notice a subscription that silently stopped receiving before a provider returns `404` or `410`.

## Failure and recovery behavior

| Failure                                        | User-visible behavior                               | Recovery                                                |
| ---------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| Approval polling fails                         | Page remains waiting and offers retry               | Resume using claim cookie                               |
| Approval expires                               | Page returns to unpaired state                      | Start a new enrollment                                  |
| Native install prompt unavailable              | Show platform fallback instruction                  | User installs manually                                  |
| User installs before `paired`                  | App may receive only the short-lived pending cookie | Remove app, return to browser, re-pair, wait, reinstall |
| Cookie not present or expired in installed app | App cannot validate pairing or toggle notifications | Remove app and repeat browser pairing and installation  |
| Notification permission denied                 | Device remains approved but inactive                | Explain how to change OS settings or re-enroll          |
| Subscription attachment rejected               | Show setup error without exposing endpoint details  | Retry after validation or re-enroll                     |
| Provider temporarily fails                     | CLI already reported queued                         | D1 retry schedule                                       |
| Provider returns 404/410                       | Device becomes disabled                             | Owner re-enrolls device                                 |
| Click target changed or expired                | Root shows muted `link expired`                     | Open the desired site independently                     |
| Owner revokes during retry                     | Pending rows stop being sent                        | Delivery query rechecks active status                   |

## Implementation slices

### Slice 0: transport and platform spike

- Generate test VAPID keys outside production.
- Select or prototype the Worker-compatible Web Push transport.
- Deliver to Android Chrome and iOS Home Screen web apps.
- Record actual subscription endpoint origins and response behavior, including the candidate FCM,
  Apple, Mozilla, and Windows host patterns.
- Verify payload size, Unicode, closed-app delivery, and click handling.
- Verify that iOS installation copies an HTTP-only cookie from every supported source browser.
- Verify that Home Screen launch sends the copied `SameSite=Lax` cookie.
- Verify the required ordering: approve, activation response sets long-lived cookie, footer renders
  `paired`, then install.
- Verify whether a service-worker push handler can renew the cookie through credentialed fetch.
- Verify Android browser-tab Web Push capability, while keeping install-first as the v1 product
  default unless explicitly changed.
- Verify multi-install endpoint behavior.
- Produce a written go/no-go result before schema implementation.

### Slice 1: shared contracts and schema

- Add request/response types to `shared/types.ts`.
- Add a new numbered D1 migration and update `worker/schema.sql`.
- Add device state transition helpers in a dedicated notification module.
- Keep notification persistence out of the security email tables.

### Slice 2: enrollment and owner approval

- Add public enrollment routes outside the global `/api/*` bearer gate.
- Add claim-cookie generation and verification.
- Add owner approval preview, code-addressed approval, device list, and revoke routes.
- Store bounded enrollment user-agent and Cloudflare country/region/ASN metadata for approval
  preview; do not store raw IP.
- Add dedicated rate limiter configuration.
- Add expiry cleanup to scheduled work.

### Slice 3: approved installation surface

- Replace the root landing response with a small HTML shell using the existing nzip styling.
- Extend the footer from `args` to `args · pair` or `args · paired`.
- Keep pairing code markup collapsed until `pair` is activated.
- Attach manifest and service-worker registration only after approval.
- Rely on Android's ambient native install affordance and add only a muted manual fallback.
- Implement approved-only iPhone instructions.
- Implement standalone detection and the single `notifications off/on` text toggle.
- Keep device naming and management out of the public page.

### Slice 4: event and delivery path

- Add `POST /api/notify` and the D1 delivery outbox.
- Add transport adapter and endpoint validation.
- Drain immediately with `waitUntil()` and later through scheduled work using one conditional lease
  protocol.
- Implement terminal response handling and bounded retries.
- Add service-worker push and click handlers.

### Slice 5: CLI and agent surface

- Add Deno CLI commands for send, list, approve, revoke, and test. Approval previews metadata and
  requires confirmation before posting the code.
- Preserve `--json` one-line output behavior.
- Apply target and vault guardrails to `--open`.
- After the CLI contract stabilizes, expose a semantic `notify` operation through the existing agent
  interface.

### Slice 6: documentation and rollout

- Add operator setup for VAPID secrets and any new rate-limit binding.
- Add mobile pairing and permission instructions.
- Document lock-screen visibility and sender-authority limitations.
- Deploy schema before Worker code that reads it.
- Gate sending with `NOTIFY_ENABLED`, defaulting false. Enabling requires valid VAPID and provider
  allowlist configuration plus at least one real-device setup.
- Use `nzip notify test` as the final production smoke test.

## Verification plan

### Shared and CLI tests

- Request validation, including Unicode and length boundaries.
- CLI parsing for send, approve, revoke, list, and test.
- Approval preview and confirmation, including generic errors for unknown, expired, and used codes.
- JSON output stability.
- `--open` target resolution and `allowVaults` refusal.
- No absolute or cross-origin click target accepted.

Run with the repository's Deno tasks:

```text
deno task check
deno task fmt:check
deno task lint
deno task test
```

### Worker unit tests

- Claim generation, hashing, expiry, and cookie attributes.
- Pairing-code uniqueness retry and exact-one-match approval behavior.
- Two tabs activating one approved claim concurrently, including a dropped first response; both
  retain the same valid claim.
- Every legal and illegal device state transition.
- Approval cannot activate a device.
- Unapproved claims cannot attach subscriptions.
- Revoked and expired claims cannot attach or refresh subscriptions.
- Endpoint parser and SSRF cases.
- Operator allowlist parsing, provider match rules, own-zone rejection, and redirect rejection.
- Endpoint-hash collision steals from and disables the old row atomically.
- Identical launch re-attachment is a no-op; changed subscription material replaces the old
  endpoint.
- Event validation and relative-path normalization.
- Click-target validation refuses a deleted, reallocated, or re-pushed address.
- D1 event/delivery insertion is atomic.
- Retry schedule and response classification.
- Concurrent immediate and cron drains race for one row and issue exactly one outbound request.
- Expired delivery leases recover; stale lease owners cannot overwrite the new result.
- Revocation prevents later outbox drains.
- VAPID rotation disables active subscriptions without revoking device approval.
- Pending enrollment capacity prunes expired rows, rejects at 32 live rows, and never evicts a live
  enrollment.
- Raw secrets and payload bodies do not appear in logs.

### Worker runtime tests

- Root enrollment and polling routes.
- Approval activation is explicit, idempotent, and must finish before install promotion appears.
- Existing `/api/*` bearer behavior remains unchanged.
- Public enrollment endpoints reject cross-origin and oversized requests.
- Scheduled retries resume a delivery left pending after the request finishes.
- Service-worker, manifest, and icon responses have correct content types and cache policies.
- `/` contains no cookie-derived state or `Set-Cookie`; every `/_notify/*` response is `no-store`.
- Root visits do not create enrollment until `pair` is activated.
- Pairing code is absent from the collapsed DOM and appears only after activation.
- Normal browser mode never renders the notification toggle.
- Standalone mode renders exactly one notification action.
- Offline launch does not present an enabled toggle before server claim validation.
- Poll cadence stays below the claim-read limiter.

Run:

```text
cd worker
npm run check
npm test
```

### Manual device matrix

| Platform        | Browser/context         | Required result                                                     |
| --------------- | ----------------------- | ------------------------------------------------------------------- |
| Current Android | Chrome browser          | No install promotion before approval                                |
| Current Android | Chrome browser          | Native ambient install affordance or muted fallback after approval  |
| Current Android | Installed PWA           | Permission, subscription, receive, tap route, revoke                |
| Current iPhone  | Safari/browser          | No Add to Home Screen instruction before approval                   |
| Current iPhone  | Safari/browser          | Approved-only Share -> Add to Home Screen instruction               |
| Current iPhone  | Home Screen app         | Claim survives install, permission works, receive while closed      |
| Current iPhone  | Home Screen app         | Notification tap opens `/` or the unchanged manifest-pinned site    |
| Both            | OS notifications denied | Clear inactive state and recovery instruction                       |
| Both            | Endpoint invalidated    | Device becomes disabled after provider response                     |
| Both            | Installed PWA           | Footer toggle turns subscription off and back on without re-pairing |

Also test a device that manually installs before approval. It must remain unable to attach a
subscription until the owner approves its claim.

## Acceptance criteria

- A pending device cannot see nzip's install promotion.
- A fresh root visit shows only the wordmark and `args · pair`; it creates no enrollment.
- The pairing code appears only after `pair` is activated.
- `POST /api/notify/approvals` hashes the presented code and is the only owner action that
  authorizes installation promotion.
- Approval preview shows bounded enrollment metadata and requires owner confirmation.
- `POST /_notify/enrollments/activate` must succeed before the page shows `paired` or installation
  guidance.
- Approval alone does not create a recipient.
- An unapproved or expired claim cannot attach or refresh a subscription.
- No browser ever receives the nzip owner bearer token.
- Android relies on native ambient install UI when the browser exposes it; nzip adds no install
  button.
- iPhone uses approved-only Add to Home Screen instructions because no native prompt API is
  available to the page.
- The installed app requires a user gesture before notification permission.
- The installed footer reads `args · paired · notifications off/on` and has no other setup control.
- Toggling off removes subscription capability but preserves approval, allowing a later toggle on
  without re-pairing.
- A queued event is persisted before the API reports success.
- Immediate and cron drains cannot concurrently send the same delivery row while a lease is valid.
- Transient provider failures retry; expired subscriptions are disabled.
- Notification clicks open a site path only if its current manifest matches the event; reused or
  changed addresses resolve to `link expired` at `/`.
- Revocation removes subscription capability and prevents future retries.
- Current Android and current iPhone receive a test notification while the app is closed.
- Existing push, serve, password, security alert, and GC behavior remains intact.

## Rejected alternatives

### Subscribe before owner approval

Rejected. It creates browser capability material before owner authorization and does not work as a
uniform flow on iPhone, where Web Push belongs to an installed Home Screen app.

### Put the owner bearer token in the PWA

Rejected. Browser compromise would grant full site-management authority, and the token is
unnecessary for a device-specific claim.

### Promote installation to every root visitor

Rejected. It creates a public install surface unrelated to owner authorization and conflicts with
the requested owner-only experience.

### Put a device identifier in manifest `start_url`

Rejected. It creates a persistent per-install identifier and depends on browser startup behavior for
an authorization handoff.

### Accept arbitrary notification click URLs

Rejected. It turns owner notifications into a general link-push and phishing surface. Existing nzip
targets cover the intended routing use case.

### Treat `waitUntil()` as the only delivery mechanism

Rejected. The event must survive an interrupted or failed immediate drain, so D1 outbox state and
scheduled retries are required.

### Reuse `security_notifications`

Rejected. Security email payloads, retention, recipients, and retry semantics are different from
owner Web Push events.

## References to verify during implementation

- Web Push for iOS/iPadOS Home Screen web apps:
  https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- iOS/iPadOS 17.2 browser-cookie handoff to installed web apps:
  https://webkit.org/blog/14787/webkit-features-in-safari-17-2/
- Android/Chromium `beforeinstallprompt` behavior:
  https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeinstallprompt_event
- Web App Manifest `start_url` privacy considerations: https://www.w3.org/TR/appmanifest/
- Push subscription fields and encryption keys: https://www.w3.org/TR/push-api/
- Cloudflare Workers Web Crypto support:
  https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Cloudflare outbound API requests:
  https://developers.cloudflare.com/workers/configuration/integrations/apis/
- Cloudflare Queues retry behavior if the outbox design is reconsidered:
  https://developers.cloudflare.com/queues/configuration/batching-retries/
- Pushy, a minimal native APNs service on Cloudflare Workers: https://codakuma.com/pushy/

These references are time-sensitive. Re-check them when implementation begins; do not treat this
plan as a substitute for current browser and Cloudflare tests.

## Reviewer checklist

Before approving implementation, answer each item explicitly:

- [ ] Is owner-first approval the correct product boundary?
- [ ] Is a public pending-enrollment endpoint acceptable?
- [ ] Does slice 0 prove that iOS copies the HTTP-only cookie and sends it on Home Screen launch?
- [ ] Is the requirement to wait for `paired` before installation clear enough?
- [ ] Does `WEB_PUSH_ORIGINS` cover every observed provider without an unsafe wildcard?
- [ ] Is the D1 lease duration long enough for provider timeouts and short enough for recovery?
- [ ] Are retry duration and event retention acceptable?
- [ ] Is deployment-wide bearer authority sufficient for sending notifications?
- [ ] Are title/body limits and lock-screen privacy guidance sufficient?
- [ ] Is manifest-pinned click routing preferable to opening the latest content after a re-push?
- [ ] Is destructive reinstall acceptable recovery for a lost installed-app claim?
- [ ] Are the code-addressed approval and `/_notify/*` route names consistent with nzip?
- [ ] Is `args · pair(ed) · notifications off/on` sufficiently clear without added UI chrome?
- [ ] Is relying on Android's ambient installation affordance acceptable when it may not appear?
- [ ] Should Android remain install-first even if slice 0 confirms browser-tab push works?
- [ ] Is the muted iPhone Add to Home Screen instruction sufficient?
- [ ] Is last-attachment-wins acceptable when multiple installs share one approved claim?
- [ ] Does the manual device matrix cover the actual supported platforms?
- [ ] Are any implementation slices too broad to review safely?
