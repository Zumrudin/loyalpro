"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function harness() {
  const amount = { value: "10" };
  const method = { value: "cash" };
  const error = { textContent: "" };
  const payment = {
    querySelector(selector) {
      return selector.includes("amount")
        ? amount
        : selector.includes("method")
          ? method
          : null;
    },
  };
  const nodes = { jrGoodsPayment: payment, jrGoodsError: error };
  const context = vm.createContext({
    console,
    Promise,
    Number,
    Math,
    Map,
    Set,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto: {
      randomUUID: (() => {
        let n = 0;
        return () => `payment-${++n}`;
      })(),
    },
    journal: { modalRequest: 1 },
    jrEl: (id) => nodes[id] || null,
    jrCanChange: () => true,
    jrWithBusy: async (_message, action) => action(),
    stockMoney: (value) => `${value} ₽`,
    stockEsc: String,
    jrEscape: String,
    jrIcon: () => "",
  });
  vm.runInContext(
    fs.readFileSync(
      path.join(__dirname, "../frontend/js/pages/journal-stock.js"),
      "utf8",
    ),
    context,
    { filename: "journal-stock.js" },
  );
  context.setState = () =>
    vm.runInContext(
      `
    jrStockState.request = 1;
    jrStockState.record = { id: 8, paid: false, deleted: false };
    jrStockState.dirty = false;
    jrStockState.paymentIds = {};
    jrStockState.goods = { lines: [], version: 0 };
  `,
      context,
    );
  context.paymentSnapshot = () =>
    vm.runInContext("jrStockState.paymentIds[5]", context);
  return {
    context,
    amount,
    method,
    error,
    setState: context.setState,
    paymentSnapshot: context.paymentSnapshot,
  };
}

test("acknowledged goods payment is not posted twice if goods refresh fails", async () => {
  const h = harness();
  h.setState();
  h.context.stockApi = jest.fn(async (url) => {
    if (url === "/sales/5/payments") return {};
    throw new Error("refresh failed");
  });

  await h.context.jrStockPayDocument(5);
  expect(h.context.stockApi).toHaveBeenCalledWith("/sales/5/payments", {
    paymentId: "payment-1",
    method: "cash",
    amount: 10,
  });
  expect(h.paymentSnapshot()).toMatchObject({
    paymentId: "payment-1",
    method: "cash",
    amount: 10,
    confirmed: true,
  });

  await h.context.jrStockPayDocument(5);
  expect(
    h.context.stockApi.mock.calls.filter(
      ([url]) => url === "/sales/5/payments",
    ),
  ).toHaveLength(1);
});

test("pending payment keeps its original amount and method on retry", async () => {
  const h = harness();
  h.setState();
  h.context.stockApi = jest.fn(async () => {
    throw new Error("network failed");
  });

  await h.context.jrStockPayDocument(5);
  h.amount.value = "20";
  h.method.value = "card";
  await h.context.jrStockPayDocument(5);

  expect(
    h.context.stockApi.mock.calls.filter(
      ([url]) => url === "/sales/5/payments",
    ),
  ).toHaveLength(1);
  expect(h.paymentSnapshot()).toMatchObject({
    paymentId: "payment-1",
    method: "cash",
    amount: 10,
    confirmed: false,
  });
  expect(h.error.textContent).toContain("другой суммой");
});

test("typing a decimal line value preserves the focused DOM until change", () => {
  const h = harness();
  h.context.setState();
  h.context.render = jest.fn();
  vm.runInContext(
    `
    jrStockState.record = { id: 8, paid: false, deleted: false };
    jrStockState.goods.lines = [{ qty: 1, price: 10, discount: 0, kind: 'good' }];
    jrStockRenderLines = render;
  `,
    h.context,
  );
  const target = {
    dataset: { jrGoodIndex: "0", jrGoodField: "price" },
    value: "12.5",
  };
  h.context.jrStockChangeLine({ type: "input", target });
  expect(h.context.render).not.toHaveBeenCalled();
  h.context.jrStockChangeLine({ type: "change", target });
  expect(h.context.render).toHaveBeenCalledTimes(1);
});
