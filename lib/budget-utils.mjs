export function currentLocalMonth(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

export function isRecurringPeriodDue(startDate, selectedPeriod, currentPeriod = currentLocalMonth()) {
  return selectedPeriod === currentPeriod && String(startDate || "").slice(0, 7) <= currentPeriod;
}

export function chunkItems(items, size = 400) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("Chunk size must be a positive integer.");
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function budgetStatus(percent) {
  if (percent > 100) return "budget-over";
  if (percent >= 75) return "budget-warning";
  return "budget-safe";
}
