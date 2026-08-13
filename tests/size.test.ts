import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sortSizes } from "../lib/size";

describe("size ordering", () => {
  it("sorts lettered sizes in wearing order, not alphabetically", () => {
    assert.deepEqual(
      sortSizes(["XL", "S", "2XL", "M", "XS", "L"]),
      ["XS", "S", "M", "L", "XL", "2XL"],
    );
  });

  it("handles the full range Printful returns for a Bella + Canvas 3001", () => {
    assert.deepEqual(
      sortSizes(["2XL", "3XL", "4XL", "L", "M", "S", "XL", "5XL", "XS"]),
      ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"],
    );
  });

  it("treats XXL and 2XL as the same size", () => {
    const sorted = sortSizes(["XXL", "M", "XL"]);
    assert.deepEqual(sorted, ["M", "XL", "XXL"]);
  });

  it("puts one-size first and numeric sizes after lettered ones", () => {
    assert.deepEqual(
      sortSizes(["34", "M", "One size", "32"]),
      ["One size", "M", "32", "34"],
    );
  });

  it("keeps unrecognized sizes visible at the end rather than dropping them", () => {
    const sorted = sortSizes(["M", "Tall", "S"]);
    assert.deepEqual(sorted, ["S", "M", "Tall"]);
  });

  it("is case and whitespace insensitive", () => {
    assert.deepEqual(sortSizes([" xl ", "s", "M"]), ["s", "M", " xl "]);
  });
});
