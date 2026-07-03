// Store/queue scope-filter helpers, extracted from automation-runner.ts
// (domain-split refactor). Pure leaf: depends only on @temu-ai-ops/shared scope
// primitives and planner's work-item listing — no mutable runner state, no
// cross-domain imports. Shared by the manual-budget, queue-run, recovery, and
// queue-daemon domains.
//
// Note: matchesQueueDaemonTickStoreScope stays in automation-runner.ts because it
// reads the live queueDaemonState singleton; it imports these helpers back.
import {
    hasAutomationItemScope,
    matchesAutomationItemScope,
    normalizeAutomationItemUrls,
    normalizeAutomationSourceBuckets
} from "@temu-ai-ops/shared";
import type { AutomationDryRunStartInput, DianxiaomiProductWorkItem } from "@temu-ai-ops/shared";
import { listDianxiaomiProductWorkItems } from "./planner";

export const normalizeStoreScopeValue = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
export const getAutomationStoreScope = (input: AutomationDryRunStartInput = {}) => ({
    storeId: normalizeStoreScopeValue(input.storeId),
    storeName: normalizeStoreScopeValue(input.storeName)
});
export const getAutomationItemScope = (input: AutomationDryRunStartInput = {}) => ({
    itemUrls: normalizeAutomationItemUrls(input.itemUrls),
    sourceBuckets: normalizeAutomationSourceBuckets(input.sourceBuckets)
});
export const hasAutomationStoreScope = (input: AutomationDryRunStartInput = {}) => {
    const scope = getAutomationStoreScope(input);
    return Boolean(scope.storeId || scope.storeName);
};
export const hasAutomationQueueScope = (input: AutomationDryRunStartInput = {}) => hasAutomationStoreScope(input) || hasAutomationItemScope(input);
export const matchesAutomationStoreScope = (item: { storeId?: string; storeName?: string } | null | undefined, input: AutomationDryRunStartInput = {}) => {
    const scope = getAutomationStoreScope(input);
    if (!scope.storeId && !scope.storeName) {
        return true;
    }
    const storeId = normalizeStoreScopeValue(item?.storeId);
    const storeName = normalizeStoreScopeValue(item?.storeName);
    if (scope.storeId) {
        return storeId === scope.storeId;
    }
    return storeName === scope.storeName;
};
export const matchesAutomationQueueScope = (item: DianxiaomiProductWorkItem | null | undefined, input: AutomationDryRunStartInput = {}) => matchesAutomationStoreScope(item, input)
    && matchesAutomationItemScope(item ?? {}, input);
export const filterItemsByAutomationStoreScope = (items: DianxiaomiProductWorkItem[], input: AutomationDryRunStartInput = {}) => items.filter((item) => matchesAutomationQueueScope(item, input));
export const summarizeScopedWorkItems = (items: DianxiaomiProductWorkItem[]) => ({
    total: items.length,
    ready: items.filter((item) => item.status === "ready-for-automation").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    edited: items.filter((item) => item.status === "edited").length,
    needsRevision: items.filter((item) => item.status === "needs-revision").length
});
export const scopedWorkItemIds = (items: DianxiaomiProductWorkItem[]) => new Set(items.map((item) => item.id));
export const listScopedDianxiaomiProductWorkItems = (input: AutomationDryRunStartInput = {}): DianxiaomiProductWorkItem[] => filterItemsByAutomationStoreScope(listDianxiaomiProductWorkItems(Number.MAX_SAFE_INTEGER), input);
export const matchesRequestedScopeValues = (actual: string[], expected: string[]) => expected.length === 0 || expected.every((value) => actual.includes(value));
export const matchesQueueRunStoreScope = (run: { storeId?: string; storeName?: string; itemUrls?: string[]; sourceBuckets?: string[] } | null | undefined, input: AutomationDryRunStartInput = {}) => {
    const scope = getAutomationStoreScope(input);
    if (!scope.storeId && !scope.storeName) {
        const itemScope = getAutomationItemScope(input);
        if (itemScope.itemUrls.length === 0 && itemScope.sourceBuckets.length === 0) {
            return true;
        }
        return matchesRequestedScopeValues(normalizeAutomationItemUrls(run?.itemUrls), itemScope.itemUrls)
            && matchesRequestedScopeValues(normalizeAutomationSourceBuckets(run?.sourceBuckets), itemScope.sourceBuckets);
    }
    const storeId = normalizeStoreScopeValue(run?.storeId);
    const storeName = normalizeStoreScopeValue(run?.storeName);
    const storeMatches = scope.storeId ? storeId === scope.storeId : storeName === scope.storeName;
    if (!storeMatches) {
        return false;
    }
    const itemScope = getAutomationItemScope(input);
    return matchesRequestedScopeValues(normalizeAutomationItemUrls(run?.itemUrls), itemScope.itemUrls)
        && matchesRequestedScopeValues(normalizeAutomationSourceBuckets(run?.sourceBuckets), itemScope.sourceBuckets);
};
export const matchesRecoveryRunStoreScope = (run: { input?: AutomationDryRunStartInput } | null | undefined, input: AutomationDryRunStartInput = {}) => {
    if (!matchesAutomationStoreScope(run?.input ?? {}, input)) {
        return false;
    }
    const itemScope = getAutomationItemScope(input);
    return matchesRequestedScopeValues(normalizeAutomationItemUrls(run?.input?.itemUrls), itemScope.itemUrls)
        && matchesRequestedScopeValues(normalizeAutomationSourceBuckets(run?.input?.sourceBuckets), itemScope.sourceBuckets);
};
