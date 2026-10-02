# TradingAnalysis GPT Analysis

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

