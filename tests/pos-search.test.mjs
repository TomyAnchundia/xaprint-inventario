import assert from "node:assert/strict";
import test from "node:test";
import { matchesPosSearch, parsePosSearch } from "../src/utils/pos-search.ts";

const shirt = {
  productName: "Camisa calidad alta",
  category: "Ropa",
  productSku: "CAM-01",
  productBarcode: "12345",
  variantSize: "L",
  variantColor: "Blanco",
  variantSku: "CAM-01-L-BLA",
  variantBarcode: "98765",
};

test("combines product words, size and color in one search", () => {
  const query = parsePosSearch(
    "camisa calidad alta talla L color blanco",
  );

  assert.equal(matchesPosSearch(shirt, query), true);
});

test("matches terms in any order and ignores accents and case", () => {
  const query = parsePosSearch("COLOR BLANCO, talla l, CAMISA CALIDAD");

  assert.equal(matchesPosSearch(shirt, query), true);
});

test("requires every search term and exact tagged size", () => {
  assert.equal(
    matchesPosSearch(shirt, parsePosSearch("camisa calidad baja talla L")),
    false,
  );
  assert.equal(
    matchesPosSearch(
      { ...shirt, variantSize: "XL" },
      parsePosSearch("camisa talla L"),
    ),
    false,
  );
});

test("matches category, SKU and barcode with an empty query matching all", () => {
  assert.equal(
    matchesPosSearch(shirt, parsePosSearch("ropa cam-01 12345")),
    true,
  );
  assert.equal(matchesPosSearch(shirt, parsePosSearch("   ")), true);
});
