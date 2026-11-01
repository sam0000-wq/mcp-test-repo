import { test } from "node:test";
import assert from "node:assert/strict";
import { charge, refund, totalOf } from "../src/payments/charge.js";
import { createSession, isAuthorized, isSessionValid } from "../src/auth/login.js";

function fakeStore() {
  const map = new Map();
  const audit = [];
  return {
    audit,
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
    appendAudit: (e) => audit.push(e),
  };
}

test("charge：重複提交同一把 key 不會扣兩次錢（冪等）", () => {
  const store = fakeStore();
  const first = charge({ orderId: "o1", amount: 100, idempotencyKey: "k1", store });
  const second = charge({ orderId: "o1", amount: 100, idempotencyKey: "k1", store });
  assert.equal(first.cents, 10000);
  assert.equal(second.replayed, true);
  assert.equal(store.audit.length, 1, "稽核 log 只應有一筆");
});

test("charge：缺少 idempotencyKey 直接拒絕", () => {
  const store = fakeStore();
  assert.throws(() => charge({ orderId: "o1", amount: 100, store }), /idempotencyKey/);
});

test("charge：負金額或零金額要擋下", () => {
  const store = fakeStore();
  assert.throws(() => charge({ orderId: "o2", amount: 0, idempotencyKey: "k2", store }), /正整數/);
});

test("charge：每筆扣款都有稽核 log", () => {
  const store = fakeStore();
  charge({ orderId: "o3", amount: 50, idempotencyKey: "k3", store });
  assert.equal(store.audit[0].event, "charge");
});

test("refund：退款金額不可超過原扣款", () => {
  const store = fakeStore();
  charge({ orderId: "o4", amount: 100, idempotencyKey: "k4", store });
  assert.throws(() => refund({ idempotencyKey: "k4", amount: 200, store }), /超過原扣款/);
});

test("auth：member 不能執行 finance 權限", () => {
  const s = createSession({ id: "u1", role: "member" });
  assert.equal(isAuthorized(s, "finance"), false);
  assert.equal(isAuthorized(s, "member"), true);
});

test("auth：session 過期後一律拒絕", () => {
  const now = 1_000_000;
  const s = createSession({ id: "u2", role: "admin" }, now);
  assert.equal(isSessionValid(s, now + 31 * 60 * 1000), false);
  assert.equal(isAuthorized(s, "member", now + 31 * 60 * 1000), false);
});

test("auth：未知角色不可登入", () => {
  assert.throws(() => createSession({ id: "u3", role: "superuser" }), /未知角色/);
});

test("totalOf：合計用整數（分）計算", () => {
  const store = fakeStore();
  const a = charge({ orderId: "o5", amount: 10.1, idempotencyKey: "k5", store });
  const b = charge({ orderId: "o6", amount: 20.2, idempotencyKey: "k6", store });
  assert.equal(totalOf([a, b]), 3030);
});
