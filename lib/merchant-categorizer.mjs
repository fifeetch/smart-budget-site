const RULES = [
  { category: "Alimentation", confidence: 0.94, words: ["carrefour", "leclerc", "auchan", "intermarche", "lidl", "aldi", "monoprix", "supermarche", "marche", "courses", "epicerie", "picard", "boulangerie", "boucherie", "poissonnerie", "fruits et legumes", "primeur", "fast food", "snack"] },
  { category: "Loisirs", confidence: 0.93, words: ["restaurant", "brasserie", "bistrot", "pizzeria", "pizza", "kebab", "sushi", "mcdonald", "burger", "starbucks", "uber eats", "ubereats", "deliveroo", "cinema", "theatre", "concert"] },
  { category: "Loisirs", confidence: 0.91, words: ["bar ", "pub ", "discotheque", "boite de nuit", "festival", "billetterie", "ticketmaster"] },
  { category: "Transport", confidence: 0.93, words: ["total", "esso", "shell", "bp ", "carburant", "station service", "sncf", "ter ", "ratp", "navigo", "parking", "peage", "autoroute", "taxi", "uber"] },
  { category: "Charges", confidence: 0.95, words: ["edf", "engie", "eau ", "veolia", "suez", "electricite", "gaz ", "assurance", "axa", "maif", "macif", "matmut", "impot", "taxe"] },
  { category: "Logement", confidence: 0.98, words: ["loyer", "rent", "agence immobiliere", "syndic", "copropriete", "castorama", "leroy merlin", "ikea"] },
  { category: "Santé", confidence: 0.95, words: ["pharmacie", "docteur", "medecin", "dentiste", "hopital", "sante", "optique", "laboratoire"] },
  { category: "Abonnements", confidence: 0.94, words: ["orange", "sfr", "bouygues", "free mobile", "free telecom", "netflix", "spotify", "amazon prime", "canal", "disney", "adobe", "abonnement"] },
  { category: "Vêtements", confidence: 0.93, words: ["zara", "h&m", "uniqlo", "kiabi", "celio", "decathlon", "intersport", "vetement", "chaussure", "nike", "adidas"] },
  { category: "Sport", confidence: 0.92, words: ["basic fit", "fitness", "salle de sport", "club sportif", "gym", "sport"] },
  { category: "Animaux", confidence: 0.94, words: ["animalerie", "veterinaire", "veto", "zooplus", "maxi zoo", "croquette"] },
  { category: "Enfants", confidence: 0.92, words: ["creche", "ecole", "cantine", "nounou", "jouet", "toys", "bebe", "enfant"] },
  { category: "Cadeaux", confidence: 0.82, words: ["cadeau", "fleurs", "interflora"] },
  { category: "Beauté / bien-être", confidence: 0.92, words: ["coiffeur", "coiffure", "esthetique", "institut", "massage", "spa", "sephora", "beaute"] },
  { category: "Électronique", confidence: 0.9, words: ["fnac", "darty", "boulanger", "apple store", "electro depot", "electronique"] },
];

const BUDGET_REASON_RULES = [
  { budgetReason: "Restaurant ou sortie", category: "Loisirs", words: ["restaurant", "brasserie", "bistrot", "pizzeria", "pizza", "kebab", "sushi", "mcdonald", "burger", "starbucks", "uber eats", "ubereats", "deliveroo"] },
  { budgetReason: "Bar", category: "Loisirs", words: ["bar ", "pub ", "discotheque", "boite de nuit"] },
  { budgetReason: "Concert / spectacle", category: "Loisirs", words: ["theatre", "concert", "festival", "billetterie", "ticketmaster", "spectacle"] },
  { budgetReason: "Cinéma", category: "Loisirs", words: ["cinema"] },
];

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function categorizeMerchant(label, type = "expense") {
  const normalized = normalize(label);
  if (type === "income") {
    if (/salaire|paie|remuneration|virement.*salaire/.test(normalized)) {
      return { category: "Salaire", confidence: 0.98, merchant: label, reason: "revenu salarial reconnu" };
    }
    return { category: "Autre", confidence: 0.35, merchant: label, reason: "revenu à vérifier" };
  }

  const budgetRule = BUDGET_REASON_RULES.find((candidate) => candidate.words.some((word) => normalized.includes(normalize(word))));
  if (budgetRule) {
    return {
      category: budgetRule.category,
      budgetReason: budgetRule.budgetReason,
      confidence: 0.93,
      merchant: label,
      reason: "motif de dépense reconnu",
    };
  }

  const rule = RULES.find((candidate) => candidate.words.some((word) => normalized.includes(normalize(word))));
  if (rule) return { category: rule.category, confidence: rule.confidence, merchant: label, reason: "commerçant ou libellé reconnu" };
  return { category: "Autre", confidence: 0.22, merchant: label, reason: "libellé non reconnu" };
}
