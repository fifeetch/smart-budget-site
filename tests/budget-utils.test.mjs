import assert from "node:assert/strict";
import test from "node:test";
import { budgetStatus, chunkItems, currentLocalMonth, isRecurringPeriodDue } from "../lib/budget-utils.mjs";

test("uses the local calendar month instead of a fixed period", () => {
  assert.equal(currentLocalMonth(new Date(2027, 0, 15, 23, 30)), "2027-01");
  assert.equal(currentLocalMonth(new Date(2027, 10, 2, 1, 0)), "2027-11");
});

test("only generates recurring entries for the current visible month", () => {
  assert.equal(isRecurringPeriodDue("2026-01-01", "2026-07", "2026-07"), true);
  assert.equal(isRecurringPeriodDue("2026-08-01", "2026-07", "2026-07"), false);
  assert.equal(isRecurringPeriodDue("2026-01-01", "2026-08", "2026-07"), false);
  assert.equal(isRecurringPeriodDue("2026-01-01", "2026-06", "2026-07"), false);
});

test("splits large Firestore jobs below the batch limit", () => {
  const chunks = chunkItems(Array.from({ length: 901 }, (_, index) => index));
  assert.deepEqual(chunks.map((chunk) => chunk.length), [400, 400, 101]);
  assert.throws(() => chunkItems([1], 0), RangeError);
});

test("uses clear budget thresholds from 75 percent", () => {
  assert.equal(budgetStatus(74), "budget-safe");
  assert.equal(budgetStatus(75), "budget-warning");
  assert.equal(budgetStatus(100), "budget-warning");
  assert.equal(budgetStatus(101), "budget-over");
});
