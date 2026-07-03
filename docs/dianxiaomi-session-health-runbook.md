# Dianxiaomi Session Health Runbook

## Goal

Keep unattended Dianxiaomi -> Temu automation blocked whenever the browser profile exists but the actual Dianxiaomi session is no longer usable.

## What now blocks startup

Unattended startup is blocked when the latest session evidence still points to `login-or-captcha`.

The blocker can come from any of these sources:

- latest selector diagnosis target surface
- latest blocked work item failure diagnosis
- latest queue daemon audit entry

## What clears the blocker

The blocker is cleared only after the system sees a newer real Dianxiaomi diagnosis that proves:

- `surfaceStatus = real-dianxiaomi`
- Dianxiaomi host is real
- fixture mode is false
- the page is inspectable

An existing profile directory by itself is no longer enough.

## Recovery order

1. Open the automation browser profile in headed mode.
2. Finish Dianxiaomi login or CAPTCHA.
3. Open a real Dianxiaomi product edit page.
4. Capture a fresh selector diagnosis or real-page calibration.
5. Rerun `/automation/unattended-startup-check`.
6. Start the queue daemon only after `dianxiaomi-session` becomes `pass`.

## Operational notes

- This gate is intended to stop repeated unattended retries against a logged-out Dianxiaomi session.
- Queue health should prioritize `resolve-login-or-captcha` before normal resume guidance.
- If startup is blocked by both calibration freshness and session health, clear the login/CAPTCHA issue first, then capture a fresh real-page diagnosis.
