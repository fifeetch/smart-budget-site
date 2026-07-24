import assert from "node:assert/strict";
import test from "node:test";
import { parseBankCsv } from "../lib/csv.mjs";

test("parses a standard French bank export with debit and credit columns", () => {
  const result = parseBankCsv([
    "Date;Libellé;Débit;Crédit",
    "22/07/2026;Courses;62,40;",
    "18/07/2026;Salaire;;2 650,00",
  ].join("\n"));

  assert.equal(result.error, "");
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map(({ label, amount, type, date }) => ({ label, amount, type, date })),
    [
      { label: "Courses", amount: 62.4, type: "expense", date: "2026-07-22" },
      { label: "Salaire", amount: 2650, type: "income", date: "2026-07-18" },
    ],
  );
});

test("finds the header after a bank preamble and parses signed amounts", () => {
  const result = parseBankCsv([
    "sep=;",
    "Historique du compte au 23/07/2026",
    "Date opération;Libellé simplifié;Montant en euros",
    "23/07/2026;CARTE SUPERMARCHE;-45,90",
    "22/07/2026;VIREMENT RECU;1.234,56",
  ].join("\n"));

  assert.equal(result.error, "");
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].type, "expense");
  assert.equal(result.rows[0].amount, 45.9);
  assert.equal(result.rows[1].type, "income");
  assert.equal(result.rows[1].amount, 1234.56);
});

test("supports quoted comma-separated exports", () => {
  const result = parseBankCsv([
    "\"Date\",\"Description\",\"Amount\"",
    "\"2026-07-22\",\"Marché, centre-ville\",\"-62.40\"",
  ].join("\n"));

  assert.equal(result.error, "");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].label, "Marché, centre-ville");
  assert.equal(result.rows[0].type, "expense");
});

test("does not treat dates or account references as bank amounts", () => {
  const result = parseBankCsv([
    "Date opération;Date de crédit;Libellé;Référence;Débit;Crédit",
    "23/07/2026;23/07/2026;Courses;019484147040;54,20;",
    "22/07/2026;22/07/2026;Salaire;019484147040;;1850,00",
  ].join("\n"));

  assert.equal(result.error, "");
  assert.equal(result.rows.length, 2);
  assert.deepEqual(
    result.rows.map(({ label, amount, type }) => ({ label, amount, type })),
    [
      { label: "Courses", amount: 54.2, type: "expense" },
      { label: "Salaire", amount: 1850, type: "income" },
    ],
  );
});

test("returns a useful error when no money column is found", () => {
  const result = parseBankCsv("Date;Libellé\n22/07/2026;Courses");
  assert.equal(result.rows.length, 0);
  assert.match(result.error, /Montant|Débit/);
});

test("categorizes common merchants from imported bank labels", () => {
  const result = parseBankCsv([
    "Date;Libellé;Débit;Crédit",
    "01/08/2026;CARTE RESTAURANT LE CENTRAL;-30,00;",
    "02/08/2026;CARREFOUR MARKET;-54,20;",
    "03/08/2026;VIREMENT SALAIRE;;2 000,00",
    "04/08/2026;BAR LE CENTRAL;-18,00;",
    "05/08/2026;DECATHLON;-49,00;",
  ].join("\n"));

  assert.deepEqual(result.rows.map(({ category, confidence }) => ({ category, confident: confidence >= 0.8 })), [
    { category: "Loisirs", confident: true },
    { category: "Alimentation", confident: true },
    { category: "Salaire", confident: true },
    { category: "Loisirs", confident: true },
    { category: "Vêtements", confident: true },
  ]);
});
