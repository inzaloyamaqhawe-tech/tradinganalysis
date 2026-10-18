# TradingAnalysis GPT Analysis

## Current Payment Workflow (2026-10-18)

This section supersedes older payment proposals below.

1. The signed-in user selects a package on Pricing. Bank details are Capitec Bank, Inzalo Yamaqhawe Technologies, account 2542120109, Entrepreneur, branch 470010.
2. The payment reference is the user's **username**. Email, first name and surname come from their account. No ID number is collected.
3. The user selects the paid package and uploads a PDF, PNG or JPEG, maximum 2 MB, using "I've paid, submit proof".
4. Uploading creates an "Awaiting approval" record without activating access. A successful new upload replaces the previous document; an invalid or failed upload does not remove the last stored file. The latest successfully uploaded proof remains after subscription expiry, even if admin rejects it.
5. Admin uses the existing Users table, with live search and subscription/payment filters. Payment columns show package, status, upload timestamp, reference and an authenticated download button. Pending proofs have Approve payment and Reject actions.
6. After matching the proof to the bank statement, Approve payment activates the uploaded package for 30 days, carrying over remaining active time. A proof version can be approved only once. Replacing it invalidates the old review/download link.
7. The user receives a private in-app activation notification with the expiry timestamp. Rejected proofs also generate a private account notification.
8. While the server runs, hourly checks create one renewal reminder per expiry when the subscription enters its final 72 hours, and an expiry notice after it lapses. These notices survive restarts and remain visible after paid access ends. A server outage can delay a reminder until the next running check.
9. Admin sees a pending-payment badge, refreshed using the existing 60-second notification cycle. Optional sound requires enabling the payment-sound checkbox in the browser.
10. Insight-email eligibility stays Pro and higher. Monthly revenue estimates exclude admins and are not bank-statement receipts.

### Storage And Deployment

- Existing MySQL/Postgres installations automatically create the private `billing_records` table at startup; the application DB user needs CREATE permission. Proof content and metadata stay in the same database as accounts, outside public web files. Approval, expiry update and account notification use one database transaction.
- Each user has one current proof record. Account notification records are separate and contain no document copies. No ID number, passport information or residential address from the supplied bank PDF is stored.
- Without a database, demo billing uses `.billing-data.json`, or `BILLING_DATA_FILE`, on disk. Like the existing demo accounts, this requires persistent disk to survive a fresh deployment. Use the database for production.
- Uploads are checked for PDF/PNG/JPEG signatures and bounded to 2 MB; document contents still require admin verification against company statements.
- Deploy the updated Node files and public assets, then restart the service. Existing provider webhooks remain unimplemented while registration verification is pending.
- Run `npm.cmd test` for isolated payment API tests. Desktop/mobile upload, search, filter, download and approval flows were also checked locally with Playwright screenshots.

## Status (2026-10-02)

- **Done — manual activation is live and clear.** The Pricing page and checkout instructions now say PayFast/Payflex are pending verification and that plans are activated manually after payment confirmation (proof of payment / reference to info@iytechnologies.co.za). No "instant activation" wording.
- **Fixed — Elite Max can be bought and activated.** Checkout, demo activation and `/api/admin/activate` only accepted premium/pro/elite, so Elite Max silently fell back to Premium; the admin page dropdown also lacked it. All now derive the paid-plan list from `plans.js`.
- **Not started:** payment records table, admin provider-status panel, feature flags, PayFast/Payflex webhooks (items 2–6 below).

## Current Payment Situation

PayFast and Payflex registrations are still pending verification. Until those providers are approved and tested, TradingAnalysis should continue using a manual activation flow.

This is the safest path for now because users can still subscribe, while the platform avoids promising instant activation before payment webhooks are ready.

## Recommended Live Flow For Now

1. A user creates an account.
2. The user chooses a plan from the Pricing page.
3. The system shows manual payment instructions.
4. The user sends proof of payment or a payment reference.
5. The admin verifies payment manually.
6. The admin activates the user's plan from `/admin.html`.
7. The user receives access for the selected subscription period.

## Suggested Wording For Users

Use simple, honest wording on the Pricing page:

> PayFast and Payflex are currently pending verification. For now, subscriptions are activated manually after payment confirmation. Once your payment is verified, your selected plan will be activated by the admin.

Avoid wording like "instant activation" until webhooks are fully connected and tested.

## Admin Process

When proof of payment is received:

1. Open `/admin.html`.
2. Enter the admin key.
3. Search for the user's email.
4. Confirm the requested plan.
5. Activate the user for the correct number of days.
6. Send or allow the system to send the activation email.

## Improvements To Build Next

### 1. Add Payment Records

Create a proper payment history so manual and automatic payments can be tracked.

Suggested fields:

- `id`
- `user_id`
- `provider`
- `provider_reference`
- `plan`
- `amount`
- `currency`
- `status`
- `proof_url`
- `verified_by`
- `verified_at`
- `created_at`

Suggested statuses:

- `pending`
- `verified`
- `rejected`
- `refunded`
- `failed`

### 2. Add Provider Status In Admin

The admin dashboard should show:

- PayFast: pending verification
- Payflex: pending verification
- Manual activation: active

This makes it clear which payment paths are live.

### 3. Add Feature Flags

Prepare environment flags before enabling automated payments:

```env
PAYFAST_ENABLED=false
PAYFLEX_ENABLED=false
MANUAL_PAYMENTS_ENABLED=true
```

When PayFast or Payflex approval is complete, enable one provider at a time and test carefully.

### 4. Prepare Webhook Endpoints

Future endpoints can be added while disabled:

- `POST /api/payfast/webhook`
- `POST /api/payflex/webhook`

These should only activate subscriptions after the provider confirms that payment is successful.

### 5. Keep Manual Activation As Backup

Even after PayFast or Payflex goes live, keep manual activation available for:

- failed webhook cases
- EFT/manual bank payments
- special customers
- refunds or corrections
- support situations

## Priority Order

1. Keep manual activation live and clear.
2. Add payment records.
3. Add admin payment/provider status.
4. Add feature flags.
5. Add PayFast webhook after verification.
6. Add Payflex after verification and testing.

## Final Recommendation

Do not wait for PayFast and Payflex verification before improving the system. Build the payment tracking structure now, keep manual activation as the active path, and switch on automated providers only after approval and real testing.

