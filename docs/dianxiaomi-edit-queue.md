# Dianxiaomi Edit Queue

This project does not need a separate product collection system.

Dianxiaomi remains the source of truth for collected products. The automation layer only records a Dianxiaomi product/edit page reference, checks whether it satisfies Temu listing requirements, creates required edit suggestions, and then drives safe browser automation inside Dianxiaomi.

Media handling follows the same rule: use Dianxiaomi native tools for image translation, white-background processing, image editor review, and batch resize/format normalization. The project tracks whether those steps are needed or confirmed; it does not build a parallel image-processing pipeline unless a later task explicitly requires one.

## Workflow

1. Use Dianxiaomi to collect products into its collection box or product library.
2. Open the Dianxiaomi collected/product edit page.
3. Click the browser extension button to add the current item to the edit queue.
4. The server stores a `DianxiaomiProductWorkItem` with:
   - source page URL and title
   - detected image/SKU/price/stock/attribute surface
   - detected image dimensions and Dianxiaomi media-tool signals
   - requirement checks
   - suggested required/recommended edits
5. Dashboard creates an edit task only when needed.
6. Playwright opens the Dianxiaomi URL and modifies fields according to the task.
7. Safe gates still apply: dry-run first, then fill draft, then save draft. The system never publishes directly by default.

## Product Source Rule

Do not rebuild a parallel product source from scraped page data unless it is only metadata for checks or automation targeting. Original product information should stay in Dianxiaomi.

## Current Implementation

- Shared model: `DianxiaomiProductWorkItem`
- API:
  - `GET /dianxiaomi/product-work-items`
  - `POST /dianxiaomi/product-work-items`
  - `POST /dianxiaomi/product-work-items/:id/task`
- Extension button uploads a work item, not a standalone collected product.
- Dashboard shows the edit queue and can create an edit task.
- Requirement rules include media checks for image translation, target image size, white background review, and Dianxiaomi image editor review.
- Legacy `/dianxiaomi/collected-products` endpoints remain for compatibility.
