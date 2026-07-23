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

test("returns a useful error when no money column is found", () => {
  const result = parseBankCsv("Date;Libellé\n22/07/2026;Courses");
  assert.equal(result.rows.length, 0);
  assert.match(result.error, /Montant|Débit/);
});
