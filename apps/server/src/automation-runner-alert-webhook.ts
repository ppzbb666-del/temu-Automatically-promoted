// Alert-webhook domain, extracted from automation-runner.ts (domain-split refactor).
// Self-contained: owns its own mutable state (configured URL + fire history) and
// every function that reads or writes it, so no cross-module `let` reassignment is
// needed. The queue-daemon tick imports fireAlertWebhook; index.ts re-exports the
// two config accessors through the automation-runner shim.
//
// When the queue daemon parks in PAUSED (login-or-captcha, calibration stale, etc.)
// it can POST a `decision === "block"` audit entry here so off-hours operators see
// the problem without watching the dashboard.
let alertWebhookUrl = "";
let alertWebhookHistory: Array<{ at: string; status: number | null; error: string | null; decision: string; reason: string }> = [];

export const getAlertWebhookConfig = () => ({
  url: alertWebhookUrl,
  history: alertWebhookHistory.slice(-20)
});

export const setAlertWebhookConfig = (input: { url?: string }) => {
  const next = (input.url ?? "").trim();
  if (next && !/^https?:\/\//i.test(next)) {
    throw new Error("alert webhook url must start with http:// or https://");
  }
  alertWebhookUrl = next;
  return { url: alertWebhookUrl };
};

export const fireAlertWebhook = async (entry: { decision: string; reason: string; subject?: string; workItemIds?: string[]; tickId?: string | null }) => {
  if (!alertWebhookUrl) {
    return;
  }
  const payload = {
    decision: entry.decision,
    reason: entry.reason,
    subject: entry.subject ?? null,
    workItemIds: entry.workItemIds ?? [],
    tickId: entry.tickId ?? null,
    firedAt: new Date().toISOString()
  };
  try {
    const response = await fetch(alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    alertWebhookHistory.push({
      at: payload.firedAt,
      status: response.status,
      error: response.ok ? null : `HTTP ${response.status}`,
      decision: entry.decision,
      reason: entry.reason
    });
  } catch (error) {
    alertWebhookHistory.push({
      at: payload.firedAt,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      decision: entry.decision,
      reason: entry.reason
    });
  }
  if (alertWebhookHistory.length > 50) {
    alertWebhookHistory.splice(0, alertWebhookHistory.length - 50);
  }
};
