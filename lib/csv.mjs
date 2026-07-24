const HEADER_NAMES = {
  date: ["date", "date operation", "date de valeur", "booking date"],
  label: ["libelle", "description", "operation", "intitule", "detail", "motif", "wording"],
  amount: ["montant", "amount", "valeur", "somme"],
  debit: ["debit", "sortie", "withdrawal"],
  credit: ["credit", "entree", "deposit"],
};

const MONEY_HEADER_BLOCKLIST = [
  "date",
  "reference",
  "compte",
  "iban",
  "bic",
  "numero",
  "piece",
  "solde",
  "balance",
  "devise",
  "currency",
];

function normalize(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function splitCsvLine(line, delimiter) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "\"") {
      if (quoted && line[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }

  cells.push(cell.trim());
  return cells;
}

function delimiterCount(line, delimiter) {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\"") {
      if (quoted && line[index + 1] === "\"") index += 1;
      else quoted = !quoted;
    } else if (line[index] === delimiter && !quoted) {
      count += 1;
    }
  }
  return count;
}

function headerMatches(header, name) {
  return header === name
    || header.startsWith(`${name} `)
    || header.endsWith(` ${name}`)
    || header.includes(` ${name} `);
}

function findColumn(headers, names, options = {}) {
  const { blocked = [], money = false } = options;
  return headers.findIndex((header) => {
    if ([...blocked, ...(money ? MONEY_HEADER_BLOCKLIST : [])].some((blockedName) => headerMatches(header, blockedName))) {
      return false;
    }
    return names.some((name) => headerMatches(header, name));
  });
}

function parseNumber(value) {
  let source = String(value ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[€$£]/g, "")
    .trim();

  if (!source || source === "-") return 0;
  if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(source)) return 0;
  if (/[\/]/.test(source)) return 0;

  let negative = /^\(.*\)$/.test(source) || source.endsWith("-");
  source = source
    .replace(/[()]/g, "")
    .replace(/[−–—]/g, "-")
    .replace(/\s/g, "")
    .replace(/-$/, "");

  if (source.startsWith("-")) negative = true;
  source = source.replace(/[^\d.,]/g, "");
  if (!source) return 0;
  if (!/[,.]/.test(source) && source.length > 7) return 0;

  const comma = source.lastIndexOf(",");
  const dot = source.lastIndexOf(".");

  if (comma >= 0 && dot >= 0) {
    if (comma > dot) source = source.replace(/\./g, "").replace(",", ".");
    else source = source.replace(/,/g, "");
  } else if (comma >= 0) {
    const parts = source.split(",");
    source = parts.length > 2
      ? `${parts.slice(0, -1).join("")}.${parts.at(-1)}`
      : source.replace(",", ".");
  } else if (dot >= 0 && source.split(".").length > 2) {
    const parts = source.split(".");
    source = `${parts.slice(0, -1).join("")}.${parts.at(-1)}`;
  }

  const amount = Number(source);
  if (!Number.isFinite(amount)) return 0;
  return negative ? -Math.abs(amount) : amount;
}

function parseDate(value) {
  const source = String(value ?? "").trim();
  const yearFirst = source.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})/);
  if (yearFirst) {
    return `${yearFirst[1]}-${yearFirst[2].padStart(2, "0")}-${yearFirst[3].padStart(2, "0")}`;
  }

  const dayFirst = source.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
  if (dayFirst) {
    const year = dayFirst[3].length === 2 ? `20${dayFirst[3]}` : dayFirst[3];
    return `${year}-${dayFirst[2].padStart(2, "0")}-${dayFirst[1].padStart(2, "0")}`;
  }

  return new Date().toISOString().slice(0, 10);
}

export function parseBankCsv(text) {
  const source = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { rows: [], error: "Le fichier CSV est vide ou ne contient aucune opération." };
  }

  const separatorHint = lines
    .slice(0, 3)
    .map((line) => line.match(/^sep=(.)$/i)?.[1])
    .find(Boolean);
  const delimiters = [...new Set([separatorHint, ";", "\t", ",", "|"].filter(Boolean))];
  let bestHeader = null;

  lines.slice(0, 30).forEach((line, lineIndex) => {
    delimiters.forEach((delimiter) => {
      if (delimiterCount(line, delimiter) < 1) return;
      const headers = splitCsvLine(line, delimiter).map(normalize);
      const indexes = {
        date: findColumn(headers, HEADER_NAMES.date),
        label: findColumn(headers, HEADER_NAMES.label, { blocked: ["date", "montant", "debit", "credit"] }),
        amount: findColumn(headers, HEADER_NAMES.amount, { money: true }),
        debit: findColumn(headers, HEADER_NAMES.debit, { money: true }),
        credit: findColumn(headers, HEADER_NAMES.credit, { money: true }),
      };
      const hasMoney = indexes.amount >= 0 || indexes.debit >= 0 || indexes.credit >= 0;
      const score = (indexes.date >= 0 ? 2 : 0)
        + (indexes.label >= 0 ? 2 : 0)
        + (indexes.amount >= 0 ? 3 : 0)
        + (indexes.debit >= 0 ? 2 : 0)
        + (indexes.credit >= 0 ? 2 : 0);

      if (hasMoney && score >= 3 && (!bestHeader || score > bestHeader.score)) {
        bestHeader = { delimiter, indexes, lineIndex, score };
      }
    });
  });

  if (!bestHeader) {
    return {
      rows: [],
      error: "Colonnes non reconnues. Le fichier doit contenir une colonne Montant, ou des colonnes Débit et Crédit.",
    };
  }

  const { delimiter, indexes, lineIndex } = bestHeader;
  const rows = lines
    .slice(lineIndex + 1)
    .map((line, index) => {
      const cells = splitCsvLine(line, delimiter);
      const debit = indexes.debit >= 0 ? parseNumber(cells[indexes.debit]) : 0;
      const credit = indexes.credit >= 0 ? parseNumber(cells[indexes.credit]) : 0;
      const amount = indexes.amount >= 0 ? parseNumber(cells[indexes.amount]) : 0;
      const signedAmount = indexes.amount >= 0
        ? amount
        : credit !== 0
          ? Math.abs(credit)
          : debit !== 0
            ? -Math.abs(debit)
            : 0;

      const type = signedAmount >= 0 ? "income" : "expense";
      const label = indexes.label >= 0 ? cells[indexes.label] || "Opération importée" : "Opération importée";
      const classification = categorizeMerchant(label, type);
      return {
        id: `csv-${index}`,
        label,
        amount: Math.abs(signedAmount),
        type,
        category: classification.category,
        confidence: classification.confidence,
        categoryReason: classification.reason,
        date: indexes.date >= 0 ? parseDate(cells[indexes.date]) : new Date().toISOString().slice(0, 10),
      };
    })
    .filter((row) => row.amount > 0);

  return {
    rows,
    error: rows.length
      ? ""
      : "Le fichier a été lu, mais aucun montant exploitable n’a été trouvé.",
  };
}

export async function decodeBankCsvFile(file) {
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("\uFFFD")) {
    text = new TextDecoder("windows-1252").decode(buffer);
  }
  return text;
}
import { categorizeMerchant } from "./merchant-categorizer.mjs";
