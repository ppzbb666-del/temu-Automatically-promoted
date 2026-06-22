# Temu And Dianxiaomi Requirements Matrix

Updated: 2026-06-06

## Scope

This file records the highest-confidence listing requirements that should drive the unattended Dianxiaomi -> Temu automation path.

Two source classes are used:

1. Dianxiaomi help-center articles that describe current Temu integration behavior and common publish failures.
2. Real-page calibration on the user's Dianxiaomi Temu edit page (`https://www.dianxiaomi.com/web/popTemu/edit?id=161406453047896278`) captured on 2026-06-06.

Temu seller-center product-detail rules are not fully public without seller login. Where a rule below comes from Dianxiaomi help instead of a public Temu seller page, treat it as "current Dianxiaomi-confirmed Temu constraint".

## Confirmed Platform Constraints

### Shared image constraints

Confirmed from Dianxiaomi's Temu image-check article:

- Listing images should not contain non-English text or watermarks.
- Carousel/material/preview images should be square and at least `800x800`.
- Color images should be `3:4` and at least `1340x1785`.
- Description images should have width/height ratio between `0.5` and `2`, and both sides should be at least `480`.
- Each image should be no larger than `2 MB`.

Automation impact:

- Default global image-size guard should be `2 MB`.
- Current model can enforce size and fixed dimensions, but it still needs explicit ratio support for color and description images.

### Temu semi-managed (`Temu (semi managed)`)

Confirmed from Dianxiaomi's semi-managed listing guide and common-issue article:

- Product title can be entered in Chinese, but the platform language is English and the title limit is `250` characters.
- Multi-variant products can have at most `20` variants.
- One listing cannot upload product media in multiple country languages at the same time.
- Product manual must be uploaded as `PDF`, `<= 15 MB`, and all visible text should be English.
- Video should use aspect ratio `1:1`, `3:4`, or `16:9`, stay within `500 MB`, and Dianxiaomi recommends keeping it within about one minute.
- Some publish failures come from description placeholder tokens such as `[relateproductdetail]`.
- Some publish failures come from warehouse / lead-time combinations that do not match Temu's semi-managed routing rules.

Automation impact:

- Default title max length should be `250`.
- Compliance screen should block `relateproductdetail`.
- Snapshot-driven preflight now checks manual/PDF/video metadata when the page collector supplies it.
- The current variant/manual/video/size-chart/fulfillment thresholds now sit in the saved Dianxiaomi listing-rule payload, so future store-mode presets can override them without changing planner code.
- Warehouse / lead-time validation is wired as a preflight blocker when the snapshot explicitly marks fulfillment routing invalid.

### Temu local (`Temu local`)

Confirmed from Dianxiaomi's local-listing guide:

- Product title limit is `500` characters.
- Contribution SKU can only use letters and numbers.
- Clothing and shoes require a size chart.
- Size-chart upload supports exactly one image, under `3 MB`, in `jpg/png/jpeg`.
- The same video guidance (`1:1`, `3:4`, `16:9`, `<= 500 MB`) appears here as well.
- When some category attributes are missing, Dianxiaomi can push the item into Temu seller-center draft instead of finishing the listing directly.

Automation impact:

- The project needs separate requirement presets for semi-managed vs local listings.
- The queue now infers a local preset automatically from page/profile/text hints while keeping the default unattended path biased toward semi-managed items.
- Local preset enforcement now checks long-title allowance plus size-chart metadata when those fields are present in the work-item snapshot.
- Local-store draft fallback needs its own completion path; it should not be treated as the same success state as a clean Dianxiaomi publish.

## Confirmed Dianxiaomi Tool Constraints

### Image translation

Confirmed from Dianxiaomi image-translation help:

- Image translation supports Temu.
- It can handle main images, SKU images, and description images.
- It supports one-click translation and custom target languages.
- Edited output is stored in Dianxiaomi image space.

Automation impact:

- Real-page calibration currently detects the `one-click translation` entry.
- Because it is an instant page action, calibration records it as `instant-action-blocked` and does not click it during selector proving.

### White background

Confirmed from Dianxiaomi white-background help:

- White-background processing only shows images smaller than `1280x1280`.
- The source image must also be `<= 2 MB`.
- Output is stored in Dianxiaomi image space.
- Free quota is limited (`10` free uses per day in the referenced article).

Automation impact:

- White-background should never be the first automatic media step when the source image is too large.
- Size normalization/compression must run first if white-background is needed.

### Batch resize

Confirmed from Dianxiaomi batch-resize help:

- Batch resize supports fixed size or ratio-preserving resize.
- Processed output is stored in Dianxiaomi image space.

Automation impact:

- Batch resize is the safest candidate for a future deterministic pre-step before white-background or publish.

### Image space persistence

Confirmed from Dianxiaomi image-space help:

- If an image stored in Dianxiaomi image space is deleted while the product is still in draft / waiting to publish / publish-failed style states, the external image URL can fail and break listing media.

Automation impact:

- Automation should treat Dianxiaomi image-space references as durable assets.
- Cleanup jobs must never delete image-space assets tied to active or retryable work items.

## Real-Page Findings Already Confirmed

- The sampled real Dianxiaomi edit page already contains a module/image description preview instead of a direct plain-text description field.
- The automation now preserves that description by default.
- Real-page extraction now captures listing metadata needed by unattended preflight: `variantCount`, `manualDocument`, `video`, `sizeChart`, and `fulfillment`.
- On the sampled page, the observed metadata was `variantCount=29`, `manualDocument=missing`, `video=present`, `sizeChart=present`, and `fulfillment=semi-managed`.
- The real page exposes `one-click translation` and `image check` as top-level entries.
- Current calibration marks both as `instant-action-blocked` instead of clicking them.
- White-background, image-editor, and batch-resize dialog entries were not visible on the sampled page.

## What The Project Should Enforce Now

High-confidence rules that are safe to encode immediately:

- Title max length: `250`
- Temu local title max length: `500` when local hints are present
- Global image max size: `2 MB`
- Typed image max size (`mainImage`, `detailImage`, `skuImage`): `2 MB`
- Description placeholder token block: `relateproductdetail`
- Variant count max: `20`
- Manual document precheck when snapshot metadata is present:
  - `PDF`
  - `<= 15 MB`
  - English-only
- Video precheck when snapshot metadata is present:
  - `1:1`, `3:4`, or `16:9`
  - `<= 500 MB`
- Size-chart precheck when snapshot metadata is present:
  - required categories must provide a chart
  - exactly one image
  - `jpg/png/jpeg`
  - `<= 3 MB`
- Fulfillment routing block when the snapshot explicitly marks warehouse/lead-time routing invalid
- Real-page description preservation when Dianxiaomi already shows module/image preview
- Instant-action calibration block for `one-click translation` and `image check`

## Gaps Still Needing Implementation

1. Separate presets for `Temu semi managed`, `Temu full managed`, and `Temu local` beyond today's local-vs-default split.
2. Broader real-page coverage for pages that do upload a manual document, expose different store modes, or render the media areas differently from the current sampled page.
3. Ratio-based image rules for:
   - color images (`3:4`, `>= 1340x1785`)
   - description images (`0.5-2` ratio, `>= 480`)
4. Category-aware requirements for when manuals, videos, or size charts are mandatory vs optional.
5. Store-type-specific publish blockers beyond the current explicit `fulfillment.valid=false` check, including whether the current `variantCount <= 20` rule needs local/store nuance.
6. A proven execution path for instant actions such as `one-click translation`, with success/failure feedback capture and rollback rules.

## Source Links

- Dianxiaomi image translation help: https://help.dianxiaomi.com/pre/getContent.htm?id=1115
- Dianxiaomi white-background help: https://help.dianxiaomi.com/pre/getContent.htm?id=1659
- Dianxiaomi semi-managed listing guide: https://help.dianxiaomi.com/article/productManagement/2783
- Dianxiaomi local listing guide: https://help.dianxiaomi.com/pre/getContent.htm?id=2873
- Dianxiaomi Temu image-check article: https://help.dianxiaomi.com/pre/getContent.htm?id=2405
- Dianxiaomi Temu semi-managed common issues: https://help.dianxiaomi.com/pre/getContent.htm?id=2832
- Dianxiaomi batch-resize help: https://help.dianxiaomi.com/pre/getContent.htm?id=1137
- Dianxiaomi image-space help: https://help.dianxiaomi.com/pre/getContent.htm?id=1483
