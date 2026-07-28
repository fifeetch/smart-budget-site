import assert from "node:assert/strict";
import test from "node:test";
import { transactionMatchesBudgetPlan } from "../lib/budget-matching.mjs";

const reasons = {
  expense: [
    { label: "Restaurant ou sortie", category: "Loisirs" },
    { label: "Bar", category: "Loisirs" },
    { label: "Concert / spectacle", category: "Loisirs" },
  ],
  income: [],
};

const plan = (reason) => ({ type: "expense", reason });
const transaction = (label, reason) => ({
  type: "expense",
  label,
  originalLabel: label,
  category: "Loisirs",
  ...(reason ? { reason } : {}),
});

test("a detailed budget only includes its exact reason", () => {
  assert.equal(transactionMatchesBudgetPlan(transaction("Bar", "Bar"), plan("Bar"), reasons), true);
  assert.equal(transactionMatchesBudgetPlan(transaction("Restaurant ou sortie", "Restaurant ou sortie"), plan("Bar"), reasons), false);
  assert.equal(transactionMatchesBudgetPlan(transaction("Concert / spectacle", "Concert / spectacle"), plan("Bar"), reasons), false);
});

test("legacy family-only transactions are inferred without merging sibling budgets", () => {
  assert.equal(transactionMatchesBudgetPlan(transaction("BAR LE CENTRAL", "Loisirs"), plan("Bar"), reasons), true);
  assert.equal(transactionMatchesBudgetPlan(transaction("CARTE RESTAURANT LE CENTRAL", "Loisirs"), plan("Bar"), reasons), false);
  assert.equal(transactionMatchesBudgetPlan(transaction("BILLETTERIE CONCERT", "Loisirs"), plan("Bar"), reasons), false);
});

test("a family budget still includes every transaction in that family", () => {
  assert.equal(transactionMatchesBudgetPlan(transaction("Bar", "Bar"), { ...plan("Loisirs"), targetKind: "category" }, reasons), true);
  assert.equal(transactionMatchesBudgetPlan(transaction("Concert / spectacle", "Concert / spectacle"), { ...plan("Loisirs"), targetKind: "category" }, reasons), true);
});

test("the saved target kind disambiguates a category from a same-named reason", () => {
  const sameNamedReasons = { expense: [{ label: "Sport", category: "Sport" }], income: [] };
  assert.equal(transactionMatchesBudgetPlan({ ...transaction("Club sportif"), category: "Sport" }, { ...plan("Sport"), targetKind: "category" }, sameNamedReasons), true);
  assert.equal(transactionMatchesBudgetPlan({ ...transaction("Club sportif"), category: "Sport" }, { ...plan("Sport"), targetKind: "reason" }, sameNamedReasons), false);
});
