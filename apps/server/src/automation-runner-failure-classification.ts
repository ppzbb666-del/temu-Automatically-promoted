// Failure classification, extracted from automation-runner.ts (domain-split
// refactor). Pure function: maps a raw failure reason string to a structured
// DianxiaomiWorkFailureDiagnosis (category + retry routing + operator next
// action). No mutable state, no cross-domain calls — a leaf module. The runner
// re-exports classifyDianxiaomiWorkFailure to preserve its public API; the
// automation-runner.test.ts suite calls it directly.
import type { DianxiaomiWorkFailureDiagnosis } from "@temu-ai-ops/shared";

export const classifyDianxiaomiWorkFailure = (reason, source = "queue-daemon"): DianxiaomiWorkFailureDiagnosis => {
    const normalized = reason.toLowerCase();
    const includesAny = (patterns) => patterns.some((pattern) => normalized.includes(pattern));
    const base = {
        message: reason.trim() || "unknown automation failure",
        source: source as DianxiaomiWorkFailureDiagnosis["source"],
        updatedAt: new Date().toISOString()
    };
    // OOM mitigation (layer 1, item ②): an item skipped for exceeding
    // UNATTENDED_MAX_SKU is not a transient failure — auto-retrying would just
    // skip it again. It needs an operator to reduce the variant grid or raise the
    // cap. Checked FIRST so the "oom" token in its reason string does not fall
    // through to the browser-crash auto-retry branch below.
    if (includesAny(["sku-count-over-cap"])) {
        return {
            ...base,
            category: "sku-count-over-cap",
            retryable: false,
            autoRetryRecommended: false,
            nextAction: "This product's SKU count exceeds the unattended cap (UNATTENDED_MAX_SKU). Reduce the variant grid, run it on a higher-memory host, or raise the cap explicitly before retrying."
        };
    }
    // Broken source images: the product's carousel images are 0×0 (the source
    // image URLs return no data), so no ratio/media tool can make them 1:1 and the
    // batch-resize dialog has no selectable image. This is source-data corruption,
    // NOT a transient media failure — auto-retrying wastes the daemon failure
    // budget on a product that can never pass until its images are re-uploaded.
    // Checked before the media-processing branch (its reason contains 图片/batch
    // resize tokens) so it does not fall through to a retryable media failure.
    if (includesAny(["broken-source-images", "broken source images", "carousel images are 0×0", "carousel images are 0x0"])) {
        return {
            ...base,
            category: "broken-source-images",
            retryable: false,
            autoRetryRecommended: false,
            nextAction: "需重新上传源图：This product's carousel/source images are broken (0×0, the source image URLs return no data). No image tool can resize a 0×0 image. Re-upload valid product images (e.g. re-pull from the 1688 source URL) before this product can be listed."
        };
    }
    if (includesAny(["login", "captcha", "verify", "verification", "楠岃瘉鐮?", "验证码", "登录", "鐧诲綍"])) {
        return {
            ...base,
            category: "login-or-captcha",
            retryable: false,
            autoRetryRecommended: false,
            nextAction: "Open Dianxiaomi in the automation profile and finish login or CAPTCHA, then restart unattended mode."
        };
    }
    if (includesAny(["selector config", "selector validation", "missing selector", "selector", "calibration required"])) {
        return {
            ...base,
            category: "selector-config",
            retryable: false,
            autoRetryRecommended: false,
            nextAction: "Run real Dianxiaomi page calibration and save the corrected selector config before retrying."
        };
    }
    if (includesAny(["real-dianxiaomi-calibration", "fixture calibration", "calibration", "demo/smoke", "local fixture"])) {
        return {
            ...base,
            category: "real-page-calibration",
            retryable: false,
            autoRetryRecommended: false,
            nextAction: "Open a real Dianxiaomi product edit page and complete page calibration."
        };
    }
    if (includesAny(["target-surface", "wrong surface", "wrong-page", "empty-page", "non-listing", "listing edit surface", "write-blocked-wrong-surface", "url host is not dianxiaomi", "page url", "page address"])) {
        return {
            ...base,
            category: "target-surface",
            retryable: false,
            autoRetryRecommended: false,
            nextAction: "Replace the work item URL with the real Dianxiaomi product edit page and recalibrate if needed."
        };
    }
    if (includesAny(["profile lock", "browser profile", "singletonlock", "profile is locked", "user data dir"])) {
        return {
            ...base,
            category: "browser-profile",
            retryable: true,
            autoRetryRecommended: false,
            nextAction: "Close the other browser using this profile or clear the stale profile lock, then restart the daemon."
        };
    }
    // P2-1: chromium crash / OOM / disconnect. Routes to browser-profile
    // recovery (restart the browser) and is auto-retry-eligible because a
    // crash is usually transient, not a content/selector problem.
    if (includesAny(["browser crash", "browser-crash", "page crashed", "chromium crash", "browser process disconnected", "browser context closed unexpectedly", "out of memory", "oom"])) {
        return {
            ...base,
            category: "browser-profile",
            retryable: true,
            autoRetryRecommended: true,
            nextAction: "The automation browser crashed or ran out of memory. Restart the daemon to relaunch a fresh browser; if it recurs, reduce batch size or media tool concurrency."
        };
    }
    if (includesAny(["task file", "export automation task", "snapshot is stale", "unreadable task", "missing task", "could not export", "could not create automation task"])) {
        return {
            ...base,
            category: "task-file",
            retryable: true,
            autoRetryRecommended: true,
            nextAction: "Refresh the Dianxiaomi work item task file and let the queue retry it."
        };
    }
    if (includesAny([
        "media-processing-plan",
        "failurekind=",
        "image translation",
        "white background",
        "image editor",
        "batch resize",
        "图片翻译",
        "白底",
        "批量改图片尺寸",
        // Temu carousel aspect-ratio rejection at submit
        // (e.g. 产品轮播图必须1:1尺寸): a media issue the batch-resize 1:1 path
        // fixes on rerun, not an unknown failure.
        "轮播图",
        "1:1",
        "1：1",
        "必须1:1",
        "图片比例",
        "比例不",
        "尺寸不合规",
        "aspect ratio",
        "carousel",
        "图片空间不足",
        "购买空间",
        "storage quota",
        "quota exceeded",
        "insufficient storage"
    ])) {
        const storageQuota = includesAny(["failurekind=storage-quota", "图片空间不足", "空间不足", "购买空间", "image space", "storage quota", "quota exceeded", "insufficient storage"]);
        const aspectRatio = includesAny(["轮播图", "1:1", "1：1", "必须1:1", "图片比例", "比例不", "尺寸不合规", "aspect ratio", "carousel"]);
        // Aspect-ratio rejections are auto-retryable: rerunning the flow re-applies
        // batch-resize which now forces the carousel to 1:1 before submit.
        const transient = !storageQuota && (aspectRatio || includesAny(["failurekind=transient", "retryable=true"]));
        return {
            ...base,
            category: "media-processing",
            retryable: transient,
            autoRetryRecommended: aspectRatio,
            nextAction: storageQuota
                ? "Free or purchase Dianxiaomi image space, or switch to a proven image path that does not create new image-space assets, then rerun this product."
                : aspectRatio
                    ? "Temu rejected the carousel image aspect ratio (must be 1:1). Rerun the flow so batch-resize regenerates the carousel at 1:1 (自定义比例调整 → 1:1) before submit."
                    : transient
                        ? "Dianxiaomi reported a temporary media-tool issue. Retry only after confirming the same image tool can complete successfully."
                        : "Check the Dianxiaomi image tool result, fix invalid images or tool configuration, then retry this product."
        };
    }
    if (includesAny(["submit", "publish", "required", "validation", "missing required", "attribute", "failed feedback", "发布", "提交", "必填", "属性", "失败"])) {
        return {
            ...base,
            category: "publish-validation",
            retryable: true,
            autoRetryRecommended: false,
            nextAction: "Use the captured Dianxiaomi validation text to fix required fields, then move the item back to ready."
        };
    }
    return {
        ...base,
        category: "unknown",
        retryable: false,
        autoRetryRecommended: false,
        nextAction: "Review the latest automation report and logs before retrying this product."
    };
};
