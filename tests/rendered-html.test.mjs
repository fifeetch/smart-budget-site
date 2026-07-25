import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Smart Budget application", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Smart Budget/);
  assert.match(html, /Ajouter une opération/);
  assert.match(html, /Budget utilisé/);
  assert.match(html, /Évolution des dépenses/);
  assert.match(html, /Derniers mouvements/);
  assert.match(html, /Projets à venir/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("keeps the requested budget capabilities in the product source", async () => {
  const [app, css, layout] = await Promise.all([
    readFile(new URL("../app/BudgetApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(app, /deleteTransaction/);
  assert.match(app, /deleteGoal/);
  assert.match(app, /resetData/);
  assert.match(app, /saveMonthlyBudget/);
  assert.match(app, /monthlyData/);
  assert.match(app, /smart-budget-demo/);
  assert.match(app, /csvAccountId/);
  assert.match(app, /csvBalanceMode/);
  assert.match(app, /Solde après l’import/);
  assert.match(app, /Compte \/ solde/);
  assert.match(app, /loadCsvFile/);
  assert.match(app, /inviteMember/);
  assert.match(app, /Ajouter au foyer/);
  assert.match(app, /setMonthlyBudget\(0\)/);
  assert.match(app, /decodeBankCsvFile/);
  assert.match(app, /runTransaction/);
  assert.match(app, /isRecurringPeriodDue/);
  assert.match(app, /balanceVerifiedAt/);
  assert.match(app, /rowsToImport\.length > 450/);
  assert.match(app, /sendPasswordResetEmail/);
  assert.match(app, /undoLastImport/);
  assert.match(app, /transactionSearch/);
  assert.match(app, /Solde prévisionnel en fin de période/);
  assert.match(app, /budgetStatus\(plan\.percent\)/);
  assert.match(app, /Alertes budgétaires/);
  assert.match(app, /Prévision du solde en fin de période/);
  assert.match(app, /Marge après dépassements/);
  assert.match(app, /livingReserveUsed/);
  assert.match(layout, /Smart Budget/);
  const rules = await readFile(new URL("../firestore.rules", import.meta.url), "utf8");
  assert.match(rules, /joinsInvitedHousehold/);
  assert.match(rules, /updatesHouseholdSettings/);
  assert.match(rules, /validTransaction/);
  assert.match(rules, /request\.resource\.data\.ownerId == resource\.data\.ownerId/);
  assert.match(rules, /match \/users\/\{userId\}[\s\S]*allow read: if signedIn\(\) && request\.auth\.uid == userId;/);
  assert.match(css, /\.monthly-chart/);
  assert.match(css, /\.btn-danger/);
  assert.match(css, /\.budget-tile\.budget-warning/);
  assert.match(css, /\.budget-tile\.budget-over/);
  assert.match(css, /\.budget-alert-panel/);
  assert.match(css, /--danger-soft/);
  assert.match(css, /\.cash-forecast/);
});
