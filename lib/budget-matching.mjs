import { categorizeMerchant } from "./merchant-categorizer.mjs";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function transactionMatchesBudgetPlan(transaction, plan, reasonDefinitions) {
  const planType = plan.type || "expense";
  if (transaction.type !== planType || (transaction.confidence != null && transaction.confidence < 0.8)) return false;

  const definitions = reasonDefinitions[planType] || [];
  const normalizedPlanReason = normalize(plan.reason);
  const categoryPlan = plan.targetKind === "category"
    || (!plan.targetKind && definitions.some((definition) => normalize(definition.category) === normalizedPlanReason));

  if (categoryPlan) return normalize(transaction.category) === normalizedPlanReason;

  const explicitReason = transaction.reason && normalize(transaction.reason) !== normalize(transaction.category)
    ? transaction.reason
    : "";
  if (explicitReason) return normalize(explicitReason) === normalizedPlanReason;

  const labels = [transaction.originalLabel, transaction.label].filter(Boolean);
  const exactDefinition = definitions.find((definition) =>
    normalize(definition.category) === normalize(transaction.category)
    && labels.some((label) => normalize(label) === normalize(definition.label)));
  if (exactDefinition) return normalize(exactDefinition.label) === normalizedPlanReason;

  const classification = categorizeMerchant(labels.join(" "), planType);
  return normalize(classification.budgetReason) === normalizedPlanReason;
}
