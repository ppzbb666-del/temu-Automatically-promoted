import { strict as assert } from "node:assert"
import { parseProductsFromCsv, CSV_IMPORT_TEMPLATE } from "../src/csv-import.ts"

// Unit tests for the CSV product importer. parseProductsFromCsv is pure
// (string in, structured products + warnings out) and handles a lot of
// bug-prone surface: header aliases (EN/CN), quoted fields, multi-SKU grouping,
// defaults, and validation warnings. These pin the parsing contract so an
// operator's spreadsheet quirks don't silently corrupt imported products.

// ---------------------------------------------------------------------------
// Basic parse + defaults
// ---------------------------------------------------------------------------
{
  const csv = ["title,category", "Widget,Home"].join("\n")
  const { products, skippedRows, warnings } = parseProductsFromCsv(csv)
  assert.equal(products.length, 1, "one product")
  const p = products[0]
  assert.equal(p.title, "Widget", "title parsed")
  assert.equal(p.category, "Home", "category parsed")
  assert.equal(p.source, "csv", "source stamped as csv")
  assert.ok(p.id.startsWith("csv-"), "productId defaults to slug when absent")
  // NOTE: the code passes 0.2 as the weight fallback, but toNumber("") returns 0
  // (Number("") === 0, which is finite), so an empty/absent weight resolves to 0,
  // NOT 0.2. This documents the actual behavior — the 0.2 default is effectively
  // unreachable for blank cells.
  assert.equal(p.estimatedWeightKg, 0, "empty weight resolves to 0 (Number('')===0, fallback unreached)")
  assert.equal(p.skus.length, 1, "one default sku")
  assert.equal(p.skus[0].name, "默认规格", "default sku name")
  assert.equal(skippedRows, 0, "nothing skipped")
  // Missing price + stock both warn (defaulted to 0).
  assert.ok(warnings.some((w) => w.includes("成本价")), "warns on missing price")
  assert.ok(warnings.some((w) => w.includes("库存")), "warns on missing stock")

  console.log("PASS parse + defaults")
}

// ---------------------------------------------------------------------------
// Missing title → row skipped with warning
// ---------------------------------------------------------------------------
{
  const csv = ["title,category,supplierPriceCny", "HasTitle,Home,10", ",Home,5"].join("\n")
  const { products, skippedRows, warnings } = parseProductsFromCsv(csv)
  assert.equal(products.length, 1, "only the titled row becomes a product")
  assert.equal(skippedRows, 1, "one row skipped")
  assert.ok(warnings.some((w) => w.includes("缺少商品标题")), "skip warning present")

  console.log("PASS missing title → skipped")
}

// ---------------------------------------------------------------------------
// Multi-SKU grouping: rows with the same productId merge into one product
// ---------------------------------------------------------------------------
{
  const csv = [
    "productId,title,category,supplierPriceCny,skuId,skuName,stock,images",
    "P1,Widget,Home,10,P1-a,Red,5,https://a.jpg|https://b.jpg",
    "P1,Widget,Home,10,P1-b,Blue,3,"
  ].join("\n")
  const { products } = parseProductsFromCsv(csv)
  assert.equal(products.length, 1, "same productId → one product")
  const p = products[0]
  assert.deepEqual(
    p.skus.map((s) => [s.skuId, s.name, s.stock]),
    [["P1-a", "Red", 5], ["P1-b", "Blue", 3]],
    "both SKU rows grouped under the product"
  )
  // Images come from the first row that defines the product.
  assert.deepEqual(p.images, ["https://a.jpg", "https://b.jpg"], "images split on | from the first row")

  console.log("PASS multi-SKU grouping")
}

// ---------------------------------------------------------------------------
// Quoted fields with embedded commas
// ---------------------------------------------------------------------------
{
  const csv = ["title,category", '"Widget, Deluxe",Home'].join("\n")
  const { products } = parseProductsFromCsv(csv)
  assert.equal(products[0].title, "Widget, Deluxe", "quoted comma preserved in field")

  console.log("PASS quoted fields")
}

// ---------------------------------------------------------------------------
// Chinese headers + attribute parsing (： / = separators)
// ---------------------------------------------------------------------------
{
  const csv = ["商品标题,类目,成本价,属性", "中文商品,家居,20,颜色：红；尺寸=大"].join("\n")
  const { products } = parseProductsFromCsv(csv)
  const p = products[0]
  assert.equal(p.title, "中文商品", "CN title header alias")
  assert.equal(p.category, "家居", "CN category header alias")
  assert.equal(p.supplierPriceCny, 20, "CN price header alias, numeric")
  assert.deepEqual(p.attributes, { 颜色: "红", 尺寸: "大" }, "attributes parse with ： and = separators")

  console.log("PASS Chinese headers + attributes")
}

// ---------------------------------------------------------------------------
// Duplicate SKU id → warning (but still imported)
// ---------------------------------------------------------------------------
{
  const csv = [
    "productId,title,skuId,supplierPriceCny,stock",
    "P1,A,DUP,10,5",
    "P2,B,DUP,10,5"
  ].join("\n")
  const { warnings } = parseProductsFromCsv(csv)
  assert.ok(warnings.some((w) => w.includes("SKU ID 重复")), "duplicate skuId warned")

  console.log("PASS duplicate SKU id warning")
}

// ---------------------------------------------------------------------------
// Numeric coercion + stock flooring / clamping
// ---------------------------------------------------------------------------
{
  const csv = [
    "title,supplierPriceCny,estimatedWeightKg,stock",
    "Widget,15.5,0.42,7.9"
  ].join("\n")
  const p = parseProductsFromCsv(csv).products[0]
  assert.equal(p.supplierPriceCny, 15.5, "float price kept")
  assert.equal(p.estimatedWeightKg, 0.42, "float weight kept")
  assert.equal(p.skus[0].stock, 7, "stock floored to integer")

  // Negative stock clamps to 0.
  const negative = parseProductsFromCsv(["title,stock", "Widget,-3"].join("\n")).products[0]
  assert.equal(negative.skus[0].stock, 0, "negative stock clamped to 0")

  console.log("PASS numeric coercion + stock clamp")
}

// ---------------------------------------------------------------------------
// Edge cases: empty input, BOM, template constant
// ---------------------------------------------------------------------------
{
  assert.deepEqual(
    parseProductsFromCsv(""),
    { products: [], skippedRows: 0, warnings: [] },
    "empty string → empty result"
  )
  assert.deepEqual(parseProductsFromCsv("title,category").products, [], "header-only → no products")

  // A UTF-8 BOM prefix is stripped so the first header isn't corrupted.
  const withBom = "﻿title,category\nWidget,Home"
  assert.equal(parseProductsFromCsv(withBom).products.length, 1, "BOM stripped, product parsed")

  assert.ok(CSV_IMPORT_TEMPLATE.startsWith("productId,"), "template starts with the productId header")
  assert.ok(CSV_IMPORT_TEMPLATE.includes("skuName"), "template documents the skuName column")

  console.log("PASS edge cases (empty, BOM, template)")
}

console.log("ALL CSV-IMPORT TESTS PASSED")
