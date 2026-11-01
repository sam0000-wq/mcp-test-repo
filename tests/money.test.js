import { test } from "node:test";
import assert from "node:assert/strict";
import { toCents, addCents, applyDiscount, formatTwd } from "../src/utils/money.js";

test("toCents：小數金額轉換不產生浮點誤差", () => {
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.1 + 0.2), 30); // 若用浮點計算會得到 30.000000000000004
});

test("toCents：非數字要丟出錯誤，不能默默變成 NaN", () => {
  assert.throws(() => toCents("abc"), /合法數字/);
});

test("addCents：加總為整數", () => {
  assert.equal(addCents(100, 250, 50), 400);
});

test("addCents：小數直接拒絕", () => {
  assert.throws(() => addCents(100.5), /整數/);
});

test("applyDiscount：折扣四捨五入到分", () => {
  assert.equal(applyDiscount(1000, 15), 850);
  assert.equal(applyDiscount(999, 33), 669);
});

test("applyDiscount：百分比超出範圍要擋", () => {
  assert.throws(() => applyDiscount(1000, 150), /超出範圍/);
});

test("formatTwd：千分位與兩位小數", () => {
  assert.equal(formatTwd(123456), "NT$1,234.56");
  assert.equal(formatTwd(-5), "-NT$0.05");
});
