"use client";

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  Timestamp,
  arrayUnion,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  query,
  runTransaction,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { auth, db, firebaseReady } from "@/lib/firebase";
import { budgetStatus, chunkItems, currentLocalMonth, isRecurringPeriodDue } from "@/lib/budget-utils.mjs";
import { decodeBankCsvFile, parseBankCsv } from "@/lib/csv.mjs";

type ModalName = "auth" | "transaction" | "account" | "csv" | "goal" | "budget" | "budgetPlan" | "reset" | "recurring" | null;
type TransactionType = "expense" | "income";
type CsvBalanceMode = "calculate" | "keep" | "custom";
type TransactionFilter = "all" | "income" | "expense" | "review";
type BudgetPlanScope = "monthly" | "annual";

type Account = {
  id: string;
  name: string;
  type: string;
  balance: number;
  visibility: "shared" | "private";
  ownerId: string;
  debitAccountId?: string;
  balanceHistory?: { date: string; balance: number }[];
  balanceVerifiedAt?: Timestamp | string;
};

type Transaction = {
  id: string;
  label: string;
  originalLabel?: string;
  amount: number;
  type: TransactionType;
  category: string;
  reason?: string;
  accountId: string;
  date: string;
  debitDate?: string;
  createdBy?: string;
  recurringId?: string;
  importBatchId?: string;
  confidence?: number;
  categoryReason?: string;
};

type Goal = {
  id: string;
  name: string;
  target: number;
  saved: number;
  dueDate: string;
  monthly: number;
  schedule?: { date: string; amount: number }[];
};

type BudgetPlan = {
  id: string;
  type?: TransactionType;
  scope: BudgetPlanScope;
  period: string;
  reason: string;
  amount: number;
  createdBy?: string;
};

type RecurringExpense = {
  id: string;
  label: string;
  amount: number;
  category: string;
  accountId: string;
  day: number;
  startDate: string;
  active: boolean;
};

type VisibleReasons = { expense: string[]; income: string[] };

type CsvDuplicateCandidate = {
  row: ReturnType<typeof parseBankCsv>["rows"][number];
  existing: Transaction;
  daysApart: number;
};

type LastImport = {
  transactionIds: string[];
  accountId: string;
  impact: number;
  balanceMode: CsvBalanceMode;
  previousBalance: number;
};

type UndoHistoryItem =
  | { id: string; action: "transaction-created"; at: string; transaction: Transaction }
  | { id: string; action: "transaction-updated"; at: string; before: Transaction; after: Transaction }
  | { id: string; action: "transaction-deleted"; at: string; transaction: Transaction };

function transactionImpact(item: Pick<Transaction, "type" | "amount">) {
  return item.type === "income" ? item.amount : -item.amount;
}

function transactionPayload(transaction: Transaction, fallbackCreatedBy: string) {
  return {
    label: transaction.label,
    originalLabel: transaction.originalLabel,
    amount: transaction.amount,
    type: transaction.type,
    category: transaction.category,
    reason: transaction.reason,
    accountId: transaction.accountId,
    date: transaction.date,
    createdBy: transaction.createdBy || fallbackCreatedBy,
    ...(transaction.debitDate ? { debitDate: transaction.debitDate } : {}),
    ...(transaction.recurringId ? { recurringId: transaction.recurringId } : {}),
    ...(transaction.importBatchId ? { importBatchId: transaction.importBatchId } : {}),
    ...(transaction.confidence != null ? { confidence: transaction.confidence } : {}),
    ...(transaction.categoryReason ? { categoryReason: transaction.categoryReason } : {}),
  };
}

function undoHistoryTitle(item: UndoHistoryItem) {
  if (item.action === "transaction-created") return `Ajout : ${item.transaction.label}`;
  if (item.action === "transaction-updated") return `Modification : ${item.after.label}`;
  return `Suppression : ${item.transaction.label}`;
}

function undoHistoryAmount(item: UndoHistoryItem) {
  const transaction = item.action === "transaction-updated" ? item.after : item.transaction;
  return `${transaction.type === "income" ? "+" : "-"} ${money.format(transaction.amount)}`;
}

function normalizeMatchLabel(value: string) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

function daysBetween(first: string, second: string) {
  const a = new Date(`${first}T12:00:00`).getTime();
  const b = new Date(`${second}T12:00:00`).getTime();
  return Math.abs(Math.round((a - b) / 86400000));
}

function balanceVerificationLabel(value?: Timestamp | string) {
  if (!value) return "Solde à vérifier";
  const date = typeof value === "string" ? new Date(value) : value.toDate();
  return Number.isNaN(date.getTime())
    ? "Solde confirmé"
    : `Solde confirmé le ${new Intl.DateTimeFormat("fr-FR").format(date)}`;
}

const categoryIcons: Record<string, string> = {
  Alimentation: "🛒",
  Logement: "🏠",
  Charges: "🧾",
  Transport: "🚗",
  Loisirs: "🎟️",
  Santé: "🩺",
  Abonnements: "📱",
  Salaire: "💼",
  Autre: "📌",
  "Espèces": "🏧",
};

Object.assign(categoryIcons, {
  "Vêtements": "👕",
  Sport: "⚽",
  Animaux: "🐾",
  Enfants: "🧸",
  Cadeaux: "🎁",
  "Beauté / bien-être": "💆",
  "Électronique": "💻",
  Maison: "🛠️",
  Dons: "❤️",
  "Frais bancaires": "🏦",
  Remboursement: "↩️",
  "Virement interne": "🔁",
  Allocations: "🧾",
  Pension: "🤝",
  "Revenus locatifs": "🏘️",
  Vente: "💶",
  Placements: "📈",
  "Autre revenu": "💡",
});

const operationReasons: Record<TransactionType, { label: string; category: string }[]> = {
  expense: [
    { label: "Courses", category: "Alimentation" },
    { label: "Carburant", category: "Transport" },
    { label: "Facture d’électricité", category: "Charges" },
    { label: "Loyer", category: "Logement" },
    { label: "Restaurant ou sortie", category: "Loisirs" },
    { label: "Bar", category: "Loisirs" },
    { label: "Concert / spectacle", category: "Loisirs" },
    { label: "Vêtements", category: "Vêtements" },
    { label: "Sport", category: "Sport" },
    { label: "Animaux", category: "Animaux" },
    { label: "Enfants", category: "Enfants" },
    { label: "Cadeaux", category: "Cadeaux" },
    { label: "Beauté / bien-être", category: "Beauté / bien-être" },
    { label: "Électronique", category: "Électronique" },
    { label: "Santé", category: "Santé" },
    { label: "Abonnement", category: "Abonnements" },
    { label: "Autre dépense", category: "Autre" },
  ],
  income: [
    { label: "Salaire", category: "Salaire" },
    { label: "Remboursement", category: "Autre" },
    { label: "Allocation", category: "Autre" },
    { label: "Autre revenu", category: "Autre" },
  ],
};

Object.assign(operationReasons, {
  expense: [
    { label: "Courses", category: "Alimentation" },
    { label: "Courses alimentaires", category: "Alimentation" },
    { label: "Boulangerie", category: "Alimentation" },
    { label: "Marché", category: "Alimentation" },
    { label: "Fruits et légumes", category: "Alimentation" },
    { label: "Boucherie / poissonnerie", category: "Alimentation" },
    { label: "Snacks / fast-food", category: "Alimentation" },
    { label: "Café", category: "Loisirs" },
    { label: "Carburant", category: "Transport" },
    { label: "Parking / péage", category: "Transport" },
    { label: "Transports en commun", category: "Transport" },
    { label: "Loyer", category: "Logement" },
    { label: "Électricité / gaz", category: "Charges" },
    { label: "Eau", category: "Charges" },
    { label: "Assurance", category: "Charges" },
    { label: "Impôts / taxes", category: "Charges" },
    { label: "Restaurant ou sortie", category: "Loisirs" },
    { label: "Bar", category: "Loisirs" },
    { label: "Concert / spectacle", category: "Loisirs" },
    { label: "Cinéma", category: "Loisirs" },
    { label: "Voyage / vacances", category: "Loisirs" },
    { label: "Vêtements", category: "Vêtements" },
    { label: "Sport", category: "Sport" },
    { label: "Santé / pharmacie", category: "Santé" },
    { label: "Beauté / bien-être", category: "Beauté / bien-être" },
    { label: "Abonnement", category: "Abonnements" },
    { label: "Téléphone / Internet", category: "Abonnements" },
    { label: "Électronique", category: "Électronique" },
    { label: "Maison / bricolage", category: "Maison" },
    { label: "Animaux", category: "Animaux" },
    { label: "Enfants", category: "Enfants" },
    { label: "Cadeaux", category: "Cadeaux" },
    { label: "Dons", category: "Dons" },
    { label: "Frais bancaires", category: "Frais bancaires" },
    { label: "Retrait d’espèces", category: "Espèces" },
    { label: "Remboursement", category: "Remboursement" },
    { label: "Autre dépense", category: "Autre" },
  ],
  income: [
    { label: "Salaire", category: "Salaire" },
    { label: "Prime", category: "Salaire" },
    { label: "Remboursement", category: "Remboursement" },
    { label: "Allocation", category: "Allocations" },
    { label: "Pension", category: "Pension" },
    { label: "Revenus locatifs", category: "Revenus locatifs" },
    { label: "Vente", category: "Vente" },
    { label: "Intérêts / placements", category: "Placements" },
    { label: "Cadeau reçu", category: "Autre revenu" },
    { label: "Virement santé", category: "Remboursement" },
    { label: "Virement appro compte", category: "Virement interne" },
    { label: "Autre revenu", category: "Autre revenu" },
  ],
});

const budgetReasonOptions = [...new Map([
  ...operationReasons.expense,
  ...[...new Set(operationReasons.expense.map((reason) => reason.category))].map((category) => ({ label: category, category })),
].map((reason) => [reason.label, reason])).values()];

function transactionMatchesBudgetPlan(transaction: Transaction, plan: BudgetPlan) {
  const planType = plan.type || "expense";
  if (transaction.type !== planType || (transaction.confidence != null && transaction.confidence < 0.8)) return false;
  if (transaction.reason === plan.reason) return true;
  const definition = operationReasons[planType].find((item) => item.label === plan.reason);
  if (!definition) return transaction.category === plan.reason;
  return transaction.category === definition.category && (!transaction.reason || transaction.reason === transaction.category || transaction.reason === definition.category);
}

const chartColors = ["var(--green)", "var(--coral)", "var(--yellow)", "var(--mint)", "#7ca7d8", "#b58ad3", "#89b9a1"];
const defaultVisibleReasons: VisibleReasons = {
  expense: operationReasons.expense.map((reason) => reason.label),
  income: operationReasons.income.map((reason) => reason.label),
};

const navigationItems = [
  ["▦", "Vue d’ensemble"],
  ["↕", "Transactions"],
  ["▣", "Comptes"],
  ["◎", "Projets"],
  ["◫", "Budgets"],
  ["◌", "Analyse"],
  ["♙", "Mon foyer"],
] as const;

const demoAccounts: Account[] = [
  { id: "joint", name: "Compte joint", type: "Courant", balance: 2847.55, visibility: "shared", ownerId: "demo" },
  { id: "perso", name: "Mon compte perso", type: "Courant", balance: 1234.8, visibility: "private", ownerId: "demo" },
  { id: "epargne", name: "Épargne projets", type: "Épargne", balance: 3680, visibility: "shared", ownerId: "demo" },
];

const demoTransactions: Transaction[] = [
  { id: "1", label: "Marché du samedi", amount: 62.4, type: "expense", category: "Alimentation", accountId: "joint", date: "2026-07-22" },
  { id: "2", label: "Loyer juillet", amount: 980, type: "expense", category: "Logement", accountId: "joint", date: "2026-07-20" },
  { id: "3", label: "Salaire", amount: 2650, type: "income", category: "Salaire", accountId: "perso", date: "2026-07-18" },
  { id: "4", label: "Pass Navigo", amount: 86.4, type: "expense", category: "Transport", accountId: "perso", date: "2026-07-16" },
  { id: "5", label: "Cinéma", amount: 28, type: "expense", category: "Loisirs", accountId: "joint", date: "2026-07-14" },
];

const demoGoals: Goal[] = [
  { id: "vacances", name: "Vacances en Italie", target: 2400, saved: 960, dueDate: "2027-05-01", monthly: 160 },
];

const money = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
});

const displayDate = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "short",
});

const fullDisplayDate = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export default function BudgetApp() {
  const [user, setUser] = useState<User | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>(demoAccounts);
  const [transactions, setTransactions] = useState<Transaction[]>(demoTransactions);
  const [goals, setGoals] = useState<Goal[]>(demoGoals);
  const [budgetPlans, setBudgetPlans] = useState<BudgetPlan[]>([]);
  const [recurringExpenses, setRecurringExpenses] = useState<RecurringExpense[]>([]);
  const [visibleReasons, setVisibleReasons] = useState<VisibleReasons>(defaultVisibleReasons);
  const [modal, setModal] = useState<ModalName>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [toast, setToast] = useState("");
  const [activeNav, setActiveNav] = useState("Vue d’ensemble");
  const [selectedPeriod, setSelectedPeriod] = useState(() => currentLocalMonth());
  const [csvPreview, setCsvPreview] = useState<ReturnType<typeof parseBankCsv>["rows"]>([]);
  const [csvFileName, setCsvFileName] = useState("");
  const [csvError, setCsvError] = useState("");
  const [csvAccountId, setCsvAccountId] = useState("");
  const [csvBalanceMode, setCsvBalanceMode] = useState<CsvBalanceMode>("calculate");
  const [csvCustomBalance, setCsvCustomBalance] = useState("");
  const [csvDebitDate, setCsvDebitDate] = useState("");
  const [csvDuplicateDecisions, setCsvDuplicateDecisions] = useState<Record<string, boolean>>({});
  const [transactionType, setTransactionType] = useState<TransactionType>("expense");
  const [selectedCategory, setSelectedCategory] = useState("Alimentation");
  const [selectedReason, setSelectedReason] = useState("Courses");
  const [customReason, setCustomReason] = useState("");
  const [operationPerson, setOperationPerson] = useState("");
  const [editingTransactionId, setEditingTransactionId] = useState<string | null>(null);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [editingBudgetPlanId, setEditingBudgetPlanId] = useState<string | null>(null);
  const [budgetPlanScopeDraft, setBudgetPlanScopeDraft] = useState<BudgetPlanScope>("monthly");
  const [budgetPlanPeriodDraft, setBudgetPlanPeriodDraft] = useState(() => currentLocalMonth());
  const [budgetViewScope, setBudgetViewScope] = useState<BudgetPlanScope>("monthly");
  const [budgetViewPeriod, setBudgetViewPeriod] = useState(() => currentLocalMonth());
  const [selectedBudgetPlanId, setSelectedBudgetPlanId] = useState<string | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [accountTypeDraft, setAccountTypeDraft] = useState("Courant");
  const [editingRecurringId, setEditingRecurringId] = useState<string | null>(null);
  const [transactionFilter, setTransactionFilter] = useState<TransactionFilter>("all");
  const [transactionSearch, setTransactionSearch] = useState("");
  const [transactionAccountFilter, setTransactionAccountFilter] = useState("all");
  const [transactionCategoryFilter, setTransactionCategoryFilter] = useState("all");
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set());
  const [lastImport, setLastImport] = useState<LastImport | null>(null);
  const [undoHistory, setUndoHistory] = useState<UndoHistoryItem[]>([]);
  const [monthlyBudget, setMonthlyBudget] = useState(2000);
  const [memberEmails, setMemberEmails] = useState<string[]>([]);
  const [authResolved, setAuthResolved] = useState(() => !auth);
  const [isSaving, setIsSaving] = useState(false);
  const generatedRecurringKeys = useRef(new Set<string>());
  const availableReasons = useCallback((type: TransactionType) => {
    const visible = operationReasons[type].filter((reason) => visibleReasons[type].includes(reason.label));
    return visible.length ? visible : operationReasons[type].slice(0, 1);
  }, [visibleReasons]);
  const needsPersonDetail = (reason: string) => reason.startsWith("Remboursement") || reason.startsWith("Virement appro compte");
  const visibleAccounts = useMemo(
    () => accounts.filter((account) => account.visibility === "shared" || !user || account.ownerId === user.uid),
    [accounts, user],
  );

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (!currentUser || !db) {
        setHouseholdId(null);
        setMemberEmails([]);
        const savedDemo = window.localStorage.getItem("smart-budget-demo");
        if (savedDemo) {
          try {
            const parsed = JSON.parse(savedDemo) as { accounts?: Account[]; transactions?: Transaction[]; goals?: Goal[]; budgetPlans?: BudgetPlan[]; recurringExpenses?: RecurringExpense[]; visibleReasons?: VisibleReasons; monthlyBudget?: number };
            setAccounts(parsed.accounts || demoAccounts);
            setTransactions(parsed.transactions || demoTransactions);
            setGoals(parsed.goals || demoGoals);
            setBudgetPlans(parsed.budgetPlans || []);
            setRecurringExpenses(parsed.recurringExpenses || []);
            setVisibleReasons(parsed.visibleReasons || defaultVisibleReasons);
            setMonthlyBudget(parsed.monthlyBudget || 2000);
          } catch {
            setAccounts(demoAccounts);
            setTransactions(demoTransactions);
            setGoals(demoGoals);
            setBudgetPlans([]);
            setRecurringExpenses([]);
            setVisibleReasons(defaultVisibleReasons);
          }
        } else {
          setAccounts(demoAccounts);
          setTransactions(demoTransactions);
          setGoals(demoGoals);
          setBudgetPlans([]);
          setRecurringExpenses([]);
          setVisibleReasons(defaultVisibleReasons);
        }
        setAuthResolved(true);
        return;
      }

      // Ne jamais conserver les données de démonstration pendant le chargement
      // du foyer connecté. Sinon une action lancée trop tôt peut tenter de
      // supprimer ou de modifier des documents qui n'existent pas dans
      // Firestore et faire échouer tout le batch.
      setAccounts([]);
      setTransactions([]);
        setGoals([]);
        setBudgetPlans([]);
      setRecurringExpenses([]);
      setVisibleReasons(defaultVisibleReasons);
      setMonthlyBudget(2000);

      try {
        const userRef = doc(db, "users", currentUser.uid);
        const userSnap = await getDoc(userRef);
        let nextHouseholdId = userSnap.data()?.householdId as string | undefined;

        if (!nextHouseholdId && currentUser.email) {
          const normalizedEmail = currentUser.email.trim().toLowerCase();
          const invitedHouseholds = await getDocs(query(
            collection(db, "households"),
            where("memberEmails", "array-contains", normalizedEmail),
            limit(1),
          ));
          const invitation = invitedHouseholds.docs[0];
          if (invitation) {
            nextHouseholdId = invitation.id;
            await updateDoc(invitation.ref, { memberIds: arrayUnion(currentUser.uid) });
            await setDoc(userRef, {
              email: normalizedEmail,
              displayName: currentUser.displayName || "",
              householdId: nextHouseholdId,
              joinedAt: Timestamp.now(),
            }, { merge: true });
          }
        }

        if (!nextHouseholdId) {
          nextHouseholdId = currentUser.uid;
          const normalizedEmail = currentUser.email?.trim().toLowerCase() || "";
          const batch = writeBatch(db);
          batch.set(doc(db, "households", nextHouseholdId), {
            name: `Foyer de ${currentUser.displayName || currentUser.email?.split("@")[0] || "Smart Budget"}`,
            ownerId: currentUser.uid,
            memberIds: [currentUser.uid],
            memberEmails: normalizedEmail ? [normalizedEmail] : [],
            monthlyBudget: 2000,
            visibleReasons: defaultVisibleReasons,
            createdAt: Timestamp.now(),
          });
          batch.set(userRef, {
            email: currentUser.email,
            displayName: currentUser.displayName || "",
            householdId: nextHouseholdId,
            createdAt: Timestamp.now(),
          });
          await batch.commit();

          // Le compte est créé après le foyer : les règles Firestore peuvent
          // alors vérifier que l’utilisateur est bien membre du foyer.
          await setDoc(doc(db, "households", nextHouseholdId, "accounts", "principal"), {
            name: "Compte principal",
            type: "Courant",
            balance: 0,
            visibility: "shared",
            ownerId: currentUser.uid,
            createdAt: Timestamp.now(),
          });
        }

        setHouseholdId(nextHouseholdId);
      } catch (error) {
        console.error("Initialisation du foyer impossible", error);
        setHouseholdId(null);
        setToast("Votre espace budget n’a pas pu être préparé. Rechargez la page pour réessayer.");
      } finally {
        setAuthResolved(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!db || !householdId || !user) return;
    const base = `households/${householdId}`;
    const sharedAccounts = new Map<string, Account>();
    const ownedAccounts = new Map<string, Account>();
    const syncAccounts = () => {
      const merged = new Map(sharedAccounts);
      ownedAccounts.forEach((account, id) => merged.set(id, account));
      setAccounts([...merged.values()]);
    };
    const cleanups = [
      onSnapshot(doc(db, "households", householdId), (snapshot) => {
        setMonthlyBudget(Number(snapshot.data()?.monthlyBudget || 2000));
        setMemberEmails((snapshot.data()?.memberEmails as string[] | undefined) || []);
        const savedReasons = snapshot.data()?.visibleReasons as VisibleReasons | undefined;
        if (savedReasons) setVisibleReasons({ expense: savedReasons.expense || defaultVisibleReasons.expense, income: savedReasons.income || defaultVisibleReasons.income });
      }),
      // Les règles Firestore ne permettent pas une requête non filtrée ici :
      // elle pourrait retourner le compte privé d’un autre membre.
      onSnapshot(query(collection(db, base, "accounts"), where("visibility", "==", "shared")), (snapshot) => {
        sharedAccounts.clear();
        snapshot.docs.forEach((item) => sharedAccounts.set(item.id, { id: item.id, ...item.data() } as Account));
        syncAccounts();
      }, (error) => console.error("Lecture des comptes partagés impossible", error)),
      onSnapshot(query(collection(db, base, "accounts"), where("ownerId", "==", user.uid)), (snapshot) => {
        ownedAccounts.clear();
        snapshot.docs.forEach((item) => ownedAccounts.set(item.id, { id: item.id, ...item.data() } as Account));
        syncAccounts();
      }, (error) => console.error("Lecture de vos comptes impossible", error)),
      onSnapshot(query(collection(db, base, "goals")), (snapshot) => {
        setGoals(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Goal)));
      }, (error) => console.error("Lecture des projets impossible", error)),
      onSnapshot(query(collection(db, base, "budgetPlans")), (snapshot) => {
        setBudgetPlans(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as BudgetPlan)));
      }, (error) => console.error("Lecture des budgets prévisionnels impossible", error)),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [householdId, user]);

  useEffect(() => {
    if (!db || !householdId || !user || !visibleAccounts.length) return;
    const base = `households/${householdId}`;
    const accountsForTransactions = visibleAccounts;
    const transactionsByAccount = new Map<string, Transaction[]>();
    const syncTransactions = () => {
      setTransactions([...transactionsByAccount.values()].flat().sort((a, b) => b.date.localeCompare(a.date)));
    };
    const cleanups = accountsForTransactions.map((account) => onSnapshot(
      // Le tri côté client évite de dépendre d’un index composé Firestore
      // (accountId + date), qui n’est pas toujours créé dans le projet.
      query(collection(db, base, "transactions"), where("accountId", "==", account.id)),
      (snapshot) => {
        transactionsByAccount.set(account.id, snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Transaction)));
        syncTransactions();
      },
      (error) => console.error(`Lecture des opérations de ${account.name} impossible`, error),
    ));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [householdId, user, visibleAccounts]);

  useEffect(() => {
    if (!db || !householdId || !user || !visibleAccounts.length) return;
    const byAccount = new Map<string, RecurringExpense[]>();
    const sync = () => setRecurringExpenses([...byAccount.values()].flat());
    const cleanups = visibleAccounts.map((account) => onSnapshot(
      query(collection(db, `households/${householdId}/recurringExpenses`), where("accountId", "==", account.id)),
      (snapshot) => {
        byAccount.set(account.id, snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as RecurringExpense)));
        sync();
      },
      (error) => console.error(`Lecture des charges de ${account.name} impossible`, error),
    ));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [householdId, user, visibleAccounts]);

  /*
   * Les projets sont volontairement lus dans le listener des comptes ci-dessus
   * car leurs règles sont déjà limitées aux membres du foyer.
   */
  /*
      onSnapshot(collection(db, base, "transactions"), (snapshot) => {
        setTransactions(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Transaction)));
      }),
      onSnapshot(collection(db, base, "goals"), (snapshot) => {
        setGoals(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Goal)));
      }),
  */

  useEffect(() => {
    if (!authResolved || user) return;
    window.localStorage.setItem("smart-budget-demo", JSON.stringify({ accounts, transactions, goals, budgetPlans, recurringExpenses, visibleReasons, monthlyBudget }));
  }, [accounts, authResolved, budgetPlans, goals, monthlyBudget, recurringExpenses, transactions, user, visibleReasons]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleIds = useMemo(() => new Set(visibleAccounts.map((account) => account.id)), [visibleAccounts]);
  const allVisibleTransactions = useMemo(
    () => transactions.filter((transaction) => visibleIds.has(transaction.accountId)),
    [transactions, visibleIds],
  );
  const periodTransactions = useMemo(
    () => allVisibleTransactions.filter((transaction) => transaction.date.startsWith(selectedPeriod)),
    [allVisibleTransactions, selectedPeriod],
  );
  const visibleTransactions = useMemo(
    () => {
      const filteredByType = transactionFilter === "all"
      ? periodTransactions
      : transactionFilter === "review"
        ? periodTransactions.filter((transaction) => transaction.confidence != null && transaction.confidence < 0.8)
        : periodTransactions.filter((transaction) => transaction.type === transactionFilter);
      const normalizedSearch = normalizeMatchLabel(transactionSearch);
      return filteredByType.filter((transaction) => {
        if (transactionAccountFilter !== "all" && transaction.accountId !== transactionAccountFilter) return false;
        if (transactionCategoryFilter !== "all" && transaction.category !== transactionCategoryFilter) return false;
        if (!normalizedSearch) return true;
        return normalizeMatchLabel(`${transaction.label} ${transaction.originalLabel || ""} ${transaction.category} ${transaction.reason || ""}`).includes(normalizedSearch);
      });
    },
    [periodTransactions, transactionAccountFilter, transactionCategoryFilter, transactionFilter, transactionSearch],
  );
  const transactionCategories = useMemo(
    () => [...new Set(periodTransactions.map((transaction) => transaction.category))].sort((a, b) => a.localeCompare(b, "fr")),
    [periodTransactions],
  );
  const income = periodTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expenses = periodTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  const reviewCount = allVisibleTransactions.filter((item) => item.confidence != null && item.confidence < 0.8).length;
  const recurringTotal = periodTransactions.filter((item) => item.type === "expense" && item.recurringId).reduce((sum, item) => sum + item.amount, 0);
  const balance = visibleAccounts.reduce((sum, account) => sum + Number(account.balance || 0), 0);
  const budgetUsage = monthlyBudget ? Math.min(100, Math.round((expenses / monthlyBudget) * 100)) : 0;
  const remainingBudget = Math.max(0, monthlyBudget - expenses);
  const budgetViewTransactions = useMemo(
    () => budgetViewScope === "monthly"
      ? allVisibleTransactions.filter((transaction) => transaction.date.startsWith(budgetViewPeriod))
      : allVisibleTransactions.filter((transaction) => transaction.date.startsWith(budgetViewPeriod.slice(0, 4))),
    [allVisibleTransactions, budgetViewPeriod, budgetViewScope],
  );
  const budgetPlansForView = useMemo(() => {
    const candidates = budgetPlans.filter((plan) => plan.scope === budgetViewScope);
    const byReason = new Map<string, BudgetPlan>();
    candidates.forEach((plan) => {
      const key = `${plan.type || "expense"}:${plan.reason}`;
      const current = byReason.get(key);
      const isBeforeOrAtView = plan.period <= budgetViewPeriod;
      const currentBeforeOrAtView = current ? current.period <= budgetViewPeriod : false;
      if (!current || (isBeforeOrAtView && !currentBeforeOrAtView) || (isBeforeOrAtView === currentBeforeOrAtView && (isBeforeOrAtView ? plan.period > current.period : plan.period < current.period))) {
        byReason.set(key, plan);
      }
    });
    return [...byReason.values()];
  }, [budgetPlans, budgetViewPeriod, budgetViewScope]);
  const budgetProgress = useMemo(() => budgetPlansForView.map((plan) => {
    const planType = plan.type || "expense";
    const matches = budgetViewTransactions.filter((transaction) => transactionMatchesBudgetPlan(transaction, plan));
    const spent = matches.reduce((sum, transaction) => sum + transaction.amount, 0);
    return { ...plan, type: planType, spent, transactions: matches, remaining: Math.max(0, plan.amount - spent), percent: plan.amount ? Math.round((spent / plan.amount) * 100) : 0 };
  }), [budgetPlansForView, budgetViewTransactions]);
  const budgetViewExpenses = budgetViewTransactions.filter((transaction) => transaction.type === "expense").reduce((sum, transaction) => sum + transaction.amount, 0);
  const budgetViewIncome = budgetViewTransactions.filter((transaction) => transaction.type === "income").reduce((sum, transaction) => sum + transaction.amount, 0);
  const expenseBudgetProgress = budgetProgress.filter((plan) => plan.type === "expense");
  const incomeBudgetProgress = budgetProgress.filter((plan) => plan.type === "income");
  const plannedBudgetTotal = expenseBudgetProgress.reduce((sum, plan) => sum + plan.amount, 0);
  const plannedBudgetSpent = expenseBudgetProgress.reduce((sum, plan) => sum + plan.spent, 0);
  const plannedBudgetRemaining = Math.max(0, plannedBudgetTotal - plannedBudgetSpent);
  const plannedIncomeTotal = incomeBudgetProgress.reduce((sum, plan) => sum + plan.amount, 0);
  const plannedIncomeActual = incomeBudgetProgress.reduce((sum, plan) => sum + plan.spent, 0);
  const plannedLivingRemainder = plannedIncomeTotal - plannedBudgetTotal;
  const livingReserve = Math.max(0, plannedLivingRemainder);
  const budgetCoverage = (() => {
    let reserve = livingReserve;
    return expenseBudgetProgress.map((plan) => {
      const overrun = Math.max(0, plan.spent - plan.amount);
      const reserveUsed = Math.min(reserve, overrun);
      reserve -= reserveUsed;
      return { ...plan, overrun, reserveUsed, uncoveredOverrun: overrun - reserveUsed, coveredRemaining: plan.remaining + reserveUsed };
    });
  })();
  const livingReserveUsed = budgetCoverage.reduce((sum, plan) => sum + plan.reserveUsed, 0);
  const livingReserveRemaining = Math.max(0, livingReserve - livingReserveUsed);
  const forecastPlans = (() => {
    const latestByReason = new Map<string, BudgetPlan>();
    budgetPlans.filter((plan) => plan.scope === "monthly" && plan.period <= selectedPeriod).forEach((plan) => {
      const key = `${plan.type || "expense"}:${plan.reason}`;
      const current = latestByReason.get(key);
      if (!current || plan.period > current.period) latestByReason.set(key, plan);
    });
    return [...latestByReason.values()];
  })();
  const forecastIncomePlanned = forecastPlans.filter((plan) => (plan.type || "expense") === "income").reduce((sum, plan) => sum + plan.amount, 0);
  const forecastExpensePlanned = forecastPlans.filter((plan) => (plan.type || "expense") === "expense").reduce((sum, plan) => sum + plan.amount, 0);
  const expectedIncomeRemaining = Math.max(0, forecastIncomePlanned - income);
  const expectedExpensesRemaining = Math.max(0, forecastExpensePlanned - expenses);
  const cashForecast = balance + expectedIncomeRemaining - expectedExpensesRemaining;
  const forecastBudgetProgress = forecastPlans.filter((plan) => (plan.type || "expense") === "expense").map((plan) => {
    const spent = periodTransactions.filter((transaction) => transactionMatchesBudgetPlan(transaction, plan)).reduce((sum, transaction) => sum + transaction.amount, 0);
    return { ...plan, spent, percent: plan.amount ? Math.round((spent / plan.amount) * 100) : 0 };
  });
  const overBudgetPlans = forecastBudgetProgress.filter((plan) => plan.percent > 100);
  const warningBudgetPlans = forecastBudgetProgress.filter((plan) => plan.percent >= 75 && plan.percent <= 100);
  const budgetAlerts = [
    ...(overBudgetPlans.length ? [`${overBudgetPlans.length} budget${overBudgetPlans.length > 1 ? "s" : ""} dépassé${overBudgetPlans.length > 1 ? "s" : ""}`] : []),
    ...(warningBudgetPlans.length ? [`${warningBudgetPlans.length} budget${warningBudgetPlans.length > 1 ? "s" : ""} à surveiller (75 % ou plus)`] : []),
    ...(reviewCount ? [`${reviewCount} opération${reviewCount > 1 ? "s" : ""} à vérifier`] : []),
    ...(cashForecast < 0 ? ["Solde prévisionnel négatif"] : []),
    ...(monthlyBudget > 0 && budgetUsage >= 80 ? [`${budgetUsage} % du budget mensuel utilisé`] : []),
  ];
  const selectedBudgetPlan = budgetCoverage.find((plan) => plan.id === selectedBudgetPlanId) || null;
  const budgetDetailHistory = (() => {
    if (!selectedBudgetPlan) return [];
    const count = budgetViewScope === "annual" ? 12 : 6;
    const anchor = budgetViewScope === "annual" ? `${budgetViewPeriod}-12` : budgetViewPeriod;
    const [year, month] = anchor.split("-").map(Number);
    return Array.from({ length: count }, (_, index) => {
      const date = new Date(year, month - count + index, 1);
      const period = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const spent = allVisibleTransactions.filter((transaction) => transaction.date.startsWith(period) && transactionMatchesBudgetPlan(transaction, selectedBudgetPlan)).reduce((sum, transaction) => sum + transaction.amount, 0);
      return { period, label: new Intl.DateTimeFormat("fr-FR", { month: "short" }).format(date), spent };
    });
  })();
  const analysisExpenseRows = useMemo(() => {
    const totals = new Map<string, number>();
    budgetViewTransactions.filter((transaction) => transaction.type === "expense").forEach((transaction) => {
      const key = transaction.reason || transaction.category;
      totals.set(key, (totals.get(key) || 0) + transaction.amount);
    });
    return [...totals.entries()].map(([label, value]) => ({ label, value, percent: budgetViewExpenses ? Math.round((value / budgetViewExpenses) * 100) : 0 })).sort((a, b) => b.value - a.value);
  }, [budgetViewExpenses, budgetViewTransactions]);
  const analysisIncomeRows = useMemo(() => {
    const totals = new Map<string, number>();
    budgetViewTransactions.filter((transaction) => transaction.type === "income").forEach((transaction) => {
      const key = transaction.reason || transaction.category;
      totals.set(key, (totals.get(key) || 0) + transaction.amount);
    });
    return [...totals.entries()].map(([label, value]) => ({ label, value, percent: budgetViewIncome ? Math.round((value / budgetViewIncome) * 100) : 0 })).sort((a, b) => b.value - a.value);
  }, [budgetViewIncome, budgetViewTransactions]);
  const selectedCsvAccount = visibleAccounts.find((account) => account.id === csvAccountId);
  const selectedCsvDebitAccount = selectedCsvAccount?.debitAccountId
    ? visibleAccounts.find((account) => account.id === selectedCsvAccount.debitAccountId)
    : undefined;
  const deferredCardSummaries = useMemo(
    () => visibleAccounts.filter((account) => account.type === "Carte").map((account) => {
      const pending = allVisibleTransactions
        .filter((transaction) => transaction.accountId === account.id && transaction.debitDate)
        .reduce((sum, transaction) => sum + (transaction.type === "income" ? -transaction.amount : transaction.amount), 0);
      const debitDates = allVisibleTransactions
        .filter((transaction) => transaction.accountId === account.id && transaction.debitDate)
        .map((transaction) => transaction.debitDate as string)
        .sort();
      return {
        account,
        pending,
        nextDebitDate: debitDates[0],
        debitAccount: account.debitAccountId ? visibleAccounts.find((item) => item.id === account.debitAccountId) : undefined,
      };
    }),
    [allVisibleTransactions, visibleAccounts],
  );
  const parsedCsvCustomBalance = Number(csvCustomBalance.replace(/\s/g, "").replace(",", "."));
  const csvCustomBalanceIsValid = csvBalanceMode !== "custom"
    || (csvCustomBalance.trim() !== "" && Number.isFinite(parsedCsvCustomBalance));
  const csvDuplicateCandidates = useMemo<CsvDuplicateCandidate[]>(() => {
    if (!csvAccountId || !csvPreview.length) return [];
    const candidates: CsvDuplicateCandidate[] = [];
    csvPreview.forEach((row, index) => {
      const existing = allVisibleTransactions.find((transaction) => {
        if (transaction.accountId !== csvAccountId || transaction.type !== row.type || Math.abs(transaction.amount - row.amount) > 0.01) return false;
        const apart = daysBetween(transaction.date, row.date);
        if (apart > 2) return false;
        const rowLabel = normalizeMatchLabel(row.label);
        const existingLabel = normalizeMatchLabel(transaction.label);
        return apart === 0 || rowLabel === existingLabel || rowLabel.includes(existingLabel) || existingLabel.includes(rowLabel);
      });
      if (existing) candidates.push({ row: { ...row, id: row.id || `csv-${index}` }, existing, daysApart: daysBetween(existing.date, row.date) });
    });
    return candidates;
  }, [allVisibleTransactions, csvAccountId, csvPreview]);
  const csvDuplicateIds = useMemo(() => new Set(csvDuplicateCandidates.map((candidate) => candidate.row.id)), [csvDuplicateCandidates]);
  const csvRowsToImport = useMemo(() => csvPreview.filter((row) => !csvDuplicateIds.has(row.id) || csvDuplicateDecisions[row.id]), [csvDuplicateDecisions, csvDuplicateIds, csvPreview]);
  const csvIncome = csvRowsToImport.filter((row) => row.type === "income").reduce((sum, row) => sum + row.amount, 0);
  const csvExpenses = csvRowsToImport.filter((row) => row.type === "expense").reduce((sum, row) => sum + row.amount, 0);
  const csvImpact = csvIncome - csvExpenses;
  const csvProjectedBalance = Number(selectedCsvAccount?.balance || 0) + csvImpact;
  const categoryData = useMemo(() => {
    const totals = new Map<string, number>();
    visibleTransactions.filter((item) => item.type === "expense").forEach((item) => {
      totals.set(item.category, (totals.get(item.category) || 0) + item.amount);
    });
    return [...totals.entries()]
      .map(([label, value], index) => ({ label, value, color: chartColors[index % chartColors.length] }))
      .sort((a, b) => b.value - a.value);
  }, [visibleTransactions]);
  const merchantData = useMemo(() => {
    const totals = new Map<string, number>();
    periodTransactions.filter((item) => item.type === "expense").forEach((item) => totals.set(item.label, (totals.get(item.label) || 0) + item.amount));
    return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [periodTransactions]);
  const donutBackground = useMemo(() => {
    if (!expenses || !categoryData.length) return "conic-gradient(#dfe5dc 0 100%)";
    let cursor = 0;
    const stops = categoryData.map((item) => {
      const start = cursor;
      cursor += (item.value / expenses) * 100;
      return `${item.color} ${start}% ${cursor}%`;
    });
    return `conic-gradient(${stops.join(",")})`;
  }, [categoryData, expenses]);
  const monthlyData = useMemo(() => {
    const formatter = new Intl.DateTimeFormat("fr-FR", { month: "short" });
    return Array.from({ length: 6 }, (_, reverseIndex) => {
      const date = new Date();
      date.setDate(1);
      date.setMonth(date.getMonth() - (5 - reverseIndex));
      const key = date.toISOString().slice(0, 7);
      const total = allVisibleTransactions
        .filter((item) => item.type === "expense" && item.date.startsWith(key))
        .reduce((sum, item) => sum + item.amount, 0);
      return { key, label: formatter.format(date).replace(".", ""), total };
    });
  }, [allVisibleTransactions]);
  const monthlyMax = Math.max(monthlyBudget, ...monthlyData.map((item) => item.total), 1);

  useEffect(() => {
    if (!recurringExpenses.length || !visibleAccounts.length) return;
    const currentPeriod = currentLocalMonth();
    if (selectedPeriod !== currentPeriod) return;
    const [year, month] = selectedPeriod.split("-").map(Number);
    const daysInMonth = new Date(year, month, 0).getDate();
    const scheduled = recurringExpenses.filter((item) => item.active && isRecurringPeriodDue(item.startDate, selectedPeriod, currentPeriod));
    scheduled.forEach((item) => {
      const date = `${selectedPeriod}-${String(Math.min(item.day, daysInMonth)).padStart(2, "0")}`;
      const recurringKey = `${item.id}:${date}`;
      if (generatedRecurringKeys.current.has(recurringKey) || allVisibleTransactions.some((transaction) => transaction.recurringId === item.id && transaction.date === date)) return;
      generatedRecurringKeys.current.add(recurringKey);
      const transaction: Transaction = {
        id: `recurring-${item.id}-${date}`,
        label: item.label,
        originalLabel: item.label,
        amount: item.amount,
        type: "expense",
        category: item.category,
        accountId: item.accountId,
        date,
        recurringId: item.id,
        createdBy: user?.uid || "demo",
      };
      if (!user) {
        setTransactions((current) => current.some((entry) => entry.id === transaction.id) ? current : [transaction, ...current]);
        setAccounts((current) => current.map((account) => account.id === item.accountId ? { ...account, balance: account.balance - item.amount } : account));
      } else if (db && householdId) {
        const transactionRef = doc(db, "households", householdId, "transactions", transaction.id);
        const accountRef = doc(db, "households", householdId, "accounts", item.accountId);
        void runTransaction(db, async (atomic) => {
          const existing = await atomic.get(transactionRef);
          if (existing.exists()) return;
          atomic.set(transactionRef, { ...transaction, createdAt: Timestamp.now() });
          atomic.update(accountRef, {
            balance: increment(-item.amount),
            balanceVerifiedAt: deleteField(),
          });
        }).catch((error) => {
          generatedRecurringKeys.current.delete(recurringKey);
          console.error("Création de la charge récurrente impossible", error);
          setToast("Une charge récurrente n’a pas pu être enregistrée. Réessayez dans quelques instants.");
        });
      }
    });
  }, [allVisibleTransactions, householdId, recurringExpenses, selectedPeriod, user, visibleAccounts.length]);

  const openQuickExpense = (category = "Alimentation", label = "") => {
    setEditingTransactionId(null);
    setTransactionType("expense");
    setSelectedCategory(category);
    setSelectedReason(operationReasons.expense.find((reason) => reason.label === label)?.label || operationReasons.expense[0].label);
    setCustomReason("");
    setOperationPerson("");
    setModal("transaction");
  };

  const openCsvImport = () => {
    setCsvPreview([]);
    setCsvFileName("");
    setCsvError("");
    setCsvAccountId(visibleAccounts[0]?.id || "");
    setCsvBalanceMode("calculate");
    setCsvCustomBalance("");
    setCsvDebitDate(new Date().toISOString().slice(0, 10));
    setCsvDuplicateDecisions({});
    setModal("csv");
  };

  const closeCsvImport = () => {
    setCsvPreview([]);
    setCsvFileName("");
    setCsvError("");
    setCsvAccountId("");
    setCsvBalanceMode("calculate");
    setCsvCustomBalance("");
    setCsvDebitDate("");
    setCsvDuplicateDecisions({});
    setModal(null);
  };

  const loadCsvFile = async (file?: File) => {
    if (!file) return;
    setCsvFileName(file.name);
    setCsvError("");
    setCsvPreview([]);
    setCsvDuplicateDecisions({});
    try {
      const result = parseBankCsv(await decodeBankCsvFile(file));
      setCsvPreview(result.rows);
      setCsvError(result.error);
    } catch (error) {
      console.error("Lecture du fichier CSV impossible", error);
      setCsvError("Ce fichier n’a pas pu être lu. Vérifiez qu’il s’agit bien d’un export CSV de votre banque.");
    }
  };

  const chooseOperationType = useCallback((type: TransactionType) => {
    const firstReason = availableReasons(type)[0];
    setTransactionType(type);
    setSelectedReason(firstReason.label);
    setSelectedCategory(firstReason.category);
    setCustomReason("");
  }, [availableReasons]);

  const chooseReason = (label: string) => {
    const reason = operationReasons[transactionType].find((item) => item.label === label);
    setSelectedReason(label);
    if (reason) setSelectedCategory(reason.category);
    setOperationPerson("");
  };

  const openTransactionEditor = (transaction: Transaction) => {
    const reasons = operationReasons[transaction.type];
    const matchingReason = reasons.find((reason) => reason.label === transaction.reason || reason.label === transaction.label || transaction.label.startsWith(`${reason.label} — `));
    const originalLabel = transaction.originalLabel || transaction.label;
    const fallback = transaction.type === "expense" ? "Autre dépense" : "Autre revenu";
    setEditingTransactionId(transaction.id);
    setTransactionType(transaction.type);
    setSelectedCategory(transaction.category);
    setSelectedReason(matchingReason?.label || transaction.reason || fallback);
    setCustomReason(matchingReason ? "" : originalLabel);
    setOperationPerson(needsPersonDetail(transaction.label) ? transaction.label.split(" — ").slice(1).join(" — ") : "");
    setModal("transaction");
  };

  const openAccountEditor = (account?: Account) => {
    setEditingAccountId(account?.id || null);
    setAccountTypeDraft(account?.type || "Courant");
    setModal("account");
  };

  const openGoalEditor = (goal?: Goal) => {
    setEditingGoalId(goal?.id || null);
    setModal("goal");
  };

  const openRecurringEditor = (item?: RecurringExpense) => {
    setEditingRecurringId(item?.id || null);
    setModal("recurring");
  };

  const showMobileOperation = () => {
    setActiveNav("Vue d’ensemble");
    window.setTimeout(() => {
      document.getElementById("mobile-operation")?.scrollIntoView({ behavior: "smooth", block: "start" });
      document.getElementById("mobile-amount")?.focus();
    }, 0);
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (!isTyping && !modal && event.key.toLowerCase() === "e") {
        event.preventDefault();
        chooseOperationType("expense");
        setEditingTransactionId(null);
        setModal("transaction");
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [chooseOperationType, modal]);

  const addUndoHistoryItem = useCallback((item: Omit<UndoHistoryItem, "id" | "at">) => {
    const now = Date.now();
    setUndoHistory((current) => [
      { ...item, id: `undo-${now}-${Math.random().toString(36).slice(2, 8)}`, at: new Date(now).toISOString() } as UndoHistoryItem,
      ...current,
    ].slice(0, 5));
  }, []);

  const undoHistoryItem = async (item: UndoHistoryItem) => {
    const removeFromHistory = () => setUndoHistory((current) => current.filter((entry) => entry.id !== item.id));
    const restoreLocalBalance = (before?: Transaction, after?: Transaction) => {
      setAccounts((current) => current.map((account) => {
        let delta = 0;
        if (after?.accountId === account.id) delta -= transactionImpact(after);
        if (before?.accountId === account.id) delta += transactionImpact(before);
        return delta ? { ...account, balance: account.balance + delta } : account;
      }));
    };

    if (!user) {
      if (item.action === "transaction-created") {
        setTransactions((current) => current.filter((transaction) => transaction.id !== item.transaction.id));
        restoreLocalBalance(undefined, item.transaction);
      } else if (item.action === "transaction-deleted") {
        setTransactions((current) => [item.transaction, ...current.filter((transaction) => transaction.id !== item.transaction.id)].sort((a, b) => b.date.localeCompare(a.date)));
        restoreLocalBalance(item.transaction);
      } else {
        setTransactions((current) => current.map((transaction) => transaction.id === item.after.id ? item.before : transaction));
        restoreLocalBalance(item.before, item.after);
      }
      removeFromHistory();
      setToast("Modification annulée.");
      return;
    }

    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      if (item.action === "transaction-created") {
        batch.delete(doc(db, "households", householdId, "transactions", item.transaction.id));
        batch.update(doc(db, "households", householdId, "accounts", item.transaction.accountId), {
          balance: increment(-transactionImpact(item.transaction)),
          balanceVerifiedAt: deleteField(),
        });
      } else if (item.action === "transaction-deleted") {
        batch.set(doc(db, "households", householdId, "transactions", item.transaction.id), transactionPayload(item.transaction, user.uid));
        batch.update(doc(db, "households", householdId, "accounts", item.transaction.accountId), {
          balance: increment(transactionImpact(item.transaction)),
          balanceVerifiedAt: deleteField(),
        });
      } else {
        batch.set(doc(db, "households", householdId, "transactions", item.before.id), transactionPayload(item.before, user.uid));
        if (item.before.accountId === item.after.accountId) {
          batch.update(doc(db, "households", householdId, "accounts", item.before.accountId), {
            balance: increment(transactionImpact(item.before) - transactionImpact(item.after)),
            balanceVerifiedAt: deleteField(),
          });
        } else {
          batch.update(doc(db, "households", householdId, "accounts", item.after.accountId), {
            balance: increment(-transactionImpact(item.after)),
            balanceVerifiedAt: deleteField(),
          });
          batch.update(doc(db, "households", householdId, "accounts", item.before.accountId), {
            balance: increment(transactionImpact(item.before)),
            balanceVerifiedAt: deleteField(),
          });
        }
      }
      await batch.commit();
      removeFromHistory();
      setToast("Modification annulée.");
    } catch (error) {
      console.error("Annulation impossible", error);
      setToast("Cette modification n’a pas pu être annulée.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleAuth = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auth || !db) return;
    setAuthError("");
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const name = String(data.get("name") || "").trim();
    try {
      if (authMode === "signup") {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        if (name) await updateProfile(credential.user, { displayName: name });
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      setModal(null);
      setToast(authMode === "signup" ? "Votre foyer Smart Budget est prêt." : "Ravi de vous revoir !");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connexion impossible.";
      setAuthError(
        message.includes("invalid-credential")
          ? "E-mail ou mot de passe incorrect."
          : message.includes("email-already-in-use")
            ? "Cette adresse e-mail est déjà utilisée."
            : message.includes("weak-password")
              ? "Choisissez un mot de passe d’au moins 6 caractères."
              : "Une erreur est survenue. Vérifiez vos informations.",
      );
    }
  };

  const resetPassword = async () => {
    if (!auth) return;
    const email = authEmail.trim();
    if (!email || !email.includes("@")) {
      setAuthError("Saisissez votre adresse e-mail avant de demander un nouveau mot de passe.");
      return;
    }
    setAuthError("");
    try {
      await sendPasswordResetEmail(auth, email);
      setToast("Un e-mail de réinitialisation vient de vous être envoyé.");
    } catch (error) {
      console.error("Réinitialisation du mot de passe impossible", error);
      setAuthError("L’e-mail de réinitialisation n’a pas pu être envoyé. Vérifiez l’adresse puis réessayez.");
    }
  };

  const addTransaction = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = Number(String(data.get("amount")).replace(",", "."));
    if (!amount || amount <= 0) {
      setToast("Saisissez un montant supérieur à zéro.");
      return;
    }
    const reasonLabel = String(data.get("reason") || selectedReason);
    const reason = operationReasons[transactionType].find((item) => item.label === reasonLabel);
    const customLabel = String(data.get("customReason") || "").trim();
    const person = String(data.get("person") || operationPerson).trim();
    const label = needsPersonDetail(reasonLabel) && person
      ? `${reasonLabel} — ${person}`
      : reasonLabel.startsWith("Autre") && customLabel
        ? customLabel
        : reason?.label || reasonLabel;
    const accountId = String(data.get("accountId"));
    const previous = editingTransactionId ? transactions.find((item) => item.id === editingTransactionId) : undefined;
    const transaction: Transaction = {
      id: editingTransactionId || `local-${Date.now()}`,
      label,
      originalLabel: previous?.originalLabel || previous?.label || label,
      amount,
      type: transactionType,
      category: reason?.category || selectedCategory,
      reason: reasonLabel,
      accountId,
      date: String(data.get("date")),
      createdBy: user?.uid || "demo",
      ...(editingTransactionId ? { confidence: 1, categoryReason: "corrigé manuellement" } : {}),
    };
    const impact = (item: Pick<Transaction, "type" | "amount">) => item.type === "income" ? item.amount : -item.amount;
    const newImpact = impact(transaction);

    if (!user) {
      setTransactions((current) => previous
        ? current.map((item) => item.id === previous.id ? transaction : item)
        : [transaction, ...current]);
      setAccounts((current) => current.map((account) => {
        let delta = 0;
        if (previous?.accountId === account.id) delta -= impact(previous);
        if (transaction.accountId === account.id) delta += newImpact;
        return delta ? { ...account, balance: account.balance + delta } : account;
      }));
      setModal(null);
      setEditingTransactionId(null);
      setSelectedReason(operationReasons[transactionType][0].label);
      setCustomReason("");
      setOperationPerson("");
      addUndoHistoryItem(previous
        ? { action: "transaction-updated", before: previous, after: transaction }
        : { action: "transaction-created", transaction });
      setToast(previous ? "Opération modifiée en mode découverte." : "Opération ajoutée en mode découverte.");
      return;
    }
    if (!db || !householdId) {
      setToast("Votre espace budget n’est pas encore prêt. Rechargez la page puis réessayez.");
      return;
    }

    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      const reference = editingTransactionId
        ? doc(db, "households", householdId, "transactions", editingTransactionId)
        : doc(collection(db, "households", householdId, "transactions"));
      const payload = {
        label: transaction.label,
        originalLabel: transaction.originalLabel,
        amount: transaction.amount,
        type: transaction.type,
        category: transaction.category,
        reason: transaction.reason,
        accountId: transaction.accountId,
        date: transaction.date,
        createdBy: previous?.createdBy || user.uid,
        ...(previous ? { confidence: 1, categoryReason: "corrigé manuellement" } : {}),
        ...(previous ? {} : { createdAt: Timestamp.now() }),
      };
      batch.set(reference, payload, { merge: Boolean(previous) });

      if (previous?.accountId === transaction.accountId) {
        batch.update(doc(db, "households", householdId, "accounts", transaction.accountId), {
          balance: increment(newImpact - impact(previous)),
          balanceVerifiedAt: deleteField(),
        });
      } else {
        if (previous) {
          batch.update(doc(db, "households", householdId, "accounts", previous.accountId), {
            balance: increment(-impact(previous)),
            balanceVerifiedAt: deleteField(),
          });
        }
        batch.update(doc(db, "households", householdId, "accounts", transaction.accountId), {
          balance: increment(newImpact),
          balanceVerifiedAt: deleteField(),
        });
      }
      const savedTransaction = previous ? transaction : { ...transaction, id: reference.id };
      await batch.commit();
      setModal(null);
      setEditingTransactionId(null);
      setSelectedReason(operationReasons[transactionType][0].label);
      setCustomReason("");
      setOperationPerson("");
      addUndoHistoryItem(previous
        ? { action: "transaction-updated", before: previous, after: savedTransaction }
        : { action: "transaction-created", transaction: savedTransaction });
      setToast(previous ? "Opération modifiée." : "Mouvement ajouté au budget.");
    } catch (error) {
      console.error("Enregistrement de l’opération impossible", error);
      setToast("L’opération n’a pas pu être enregistrée. Vérifiez votre connexion puis réessayez.");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteTransaction = async (transaction: Transaction) => {
    if (!window.confirm(`Supprimer « ${transaction.label} » ? Le solde du compte sera recalculé.`)) return;
    const reversal = transaction.type === "income" ? -transaction.amount : transaction.amount;
    if (!user) {
      setTransactions((current) => current.filter((item) => item.id !== transaction.id));
      setAccounts((current) => current.map((account) => account.id === transaction.accountId ? { ...account, balance: account.balance + reversal } : account));
      addUndoHistoryItem({ action: "transaction-deleted", transaction });
      setToast("Opération supprimée.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "households", householdId, "transactions", transaction.id));
      batch.update(doc(db, "households", householdId, "accounts", transaction.accountId), {
        balance: increment(reversal),
        balanceVerifiedAt: deleteField(),
      });
      await batch.commit();
      addUndoHistoryItem({ action: "transaction-deleted", transaction });
      setToast("Opération supprimée et solde recalculé.");
    } catch (error) {
      console.error("Suppression impossible", error);
      setToast("Impossible de supprimer cette opération.");
    } finally {
      setIsSaving(false);
    }
  };

  const toggleTransactionSelection = (id: string) => {
    setSelectedTransactionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllVisibleTransactions = () => {
    const ids = visibleTransactions.map((transaction) => transaction.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedTransactionIds.has(id));
    setSelectedTransactionIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => allSelected ? next.delete(id) : next.add(id));
      return next;
    });
  };

  const applyBulkCategory = async (reasonLabel: string) => {
    if (!reasonLabel || !selectedTransactionIds.size) return;
    const reason = [...operationReasons.expense, ...operationReasons.income].find((item) => item.label === reasonLabel);
    if (!reason) return;
    const ids = new Set(selectedTransactionIds);
    if (!user) {
      setTransactions((current) => current.map((transaction) => ids.has(transaction.id) ? { ...transaction, originalLabel: transaction.originalLabel || transaction.label, reason: reason.label, category: reason.category, confidence: 1, categoryReason: `motif attribué en groupe : ${reason.label}` } : transaction));
      setSelectedTransactionIds(new Set());
      setToast(`${ids.size} opération(s) classée(s) avec le motif « ${reason.label} ».`);
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      for (const idChunk of chunkItems([...ids])) {
        const batch = writeBatch(db);
        idChunk.forEach((id) => {
          const transaction = transactions.find((item) => item.id === id);
          batch.update(doc(db, "households", householdId, "transactions", id), { originalLabel: transaction?.originalLabel || transaction?.label, reason: reason.label, category: reason.category, confidence: 1, categoryReason: `motif attribué en groupe : ${reason.label}` });
        });
        await batch.commit();
      }
      setSelectedTransactionIds(new Set());
      setToast(`${ids.size} opération(s) classée(s) avec le motif « ${reason.label} ».`);
    } catch (error) {
      console.error("Classement groupé impossible", error);
      setToast("Les opérations sélectionnées n’ont pas pu être classées.");
    } finally {
      setIsSaving(false);
    }
  };

  const addAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const existing = editingAccountId ? accounts.find((item) => item.id === editingAccountId) : undefined;
    const type = String(data.get("type") || "Courant");
    const debitAccountId = type === "Carte" ? String(data.get("debitAccountId") || "") : "";
    const accountId = editingAccountId || `local-account-${Date.now()}`;
    const account: Account = {
      id: accountId,
      name: String(data.get("name")),
      type,
      balance: Number(String(data.get("balance")).replace(",", ".")) || 0,
      visibility: String(data.get("visibility")) as Account["visibility"],
      ownerId: existing?.ownerId || user?.uid || "demo",
      ...(type === "Carte" && debitAccountId && debitAccountId !== accountId ? { debitAccountId } : {}),
      balanceHistory: existing?.balanceHistory || [],
    };
    const balanceDate = String(data.get("balanceDate") || new Date().toISOString().slice(0, 10));
    account.balanceHistory = [...(existing?.balanceHistory || []), { date: balanceDate, balance: account.balance }].slice(-24);
    if (!user) {
      setAccounts((current) => existing ? current.map((item) => item.id === existing.id ? account : item) : [...current, account]);
      setModal(null);
      setEditingAccountId(null);
      setToast(existing ? "Compte modifié." : "Compte ajouté en mode découverte.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const reference = existing
        ? doc(db, "households", householdId, "accounts", existing.id)
        : doc(collection(db, "households", householdId, "accounts"));
      await setDoc(reference, {
        name: account.name,
        type: account.type,
        balance: account.balance,
        visibility: account.visibility,
        ownerId: account.ownerId,
        ...(account.type === "Carte" && account.debitAccountId ? { debitAccountId: account.debitAccountId } : { debitAccountId: deleteField() }),
        balanceHistory: arrayUnion({ date: balanceDate, balance: account.balance }),
        balanceVerifiedAt: Timestamp.now(),
        ...(existing ? {} : { createdAt: Timestamp.now() }),
      }, { merge: Boolean(existing) });
      setModal(null);
      setEditingAccountId(null);
      setToast(existing ? "Compte modifié." : "Nouveau compte ajouté.");
    } catch (error) {
      console.error("Enregistrement du compte impossible", error);
      setToast("Le compte n’a pas pu être enregistré.");
    } finally {
      setIsSaving(false);
    }
  };

  const addGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const target = Number(String(data.get("target")).replace(",", "."));
    const saved = Number(String(data.get("saved")).replace(",", ".")) || 0;
    const dueDate = String(data.get("dueDate"));
    const months = Math.max(1, Math.ceil((new Date(dueDate).getTime() - Date.now()) / (30.44 * 86400000)));
    const monthly = Math.max(0, (target - saved) / months);
    const schedule = Array.from({ length: months }, (_, index) => {
      const date = new Date();
      date.setDate(1);
      date.setMonth(date.getMonth() + index + 1);
      return { date: date.toISOString().slice(0, 7), amount: monthly };
    });
    const existing = editingGoalId ? goals.find((item) => item.id === editingGoalId) : undefined;
    const goal: Goal = {
      id: editingGoalId || `local-goal-${Date.now()}`,
      name: String(data.get("name")),
      target,
      saved,
      dueDate,
      monthly,
      schedule,
    };
    if (!user) {
      setGoals((current) => existing ? current.map((item) => item.id === existing.id ? goal : item) : [...current, goal]);
      setModal(null);
      setEditingGoalId(null);
      setToast(existing ? "Projet modifié." : "Projet ajouté en mode découverte.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const reference = existing
        ? doc(db, "households", householdId, "goals", existing.id)
        : doc(collection(db, "households", householdId, "goals"));
      await setDoc(reference, {
        name: goal.name,
        target: goal.target,
        saved: goal.saved,
        dueDate: goal.dueDate,
        monthly: goal.monthly,
        schedule: goal.schedule,
        ...(existing ? {} : { createdAt: Timestamp.now() }),
      }, { merge: Boolean(existing) });
      setModal(null);
      setEditingGoalId(null);
      setToast(existing ? "Projet modifié." : "Projet ajouté avec sa mensualité conseillée.");
    } catch (error) {
      console.error("Enregistrement du projet impossible", error);
      setToast("Le projet n’a pas pu être enregistré.");
    } finally {
      setIsSaving(false);
    }
  };

  const addRecurringExpense = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const amount = Number(String(data.get("amount") || "").replace(",", "."));
    const accountId = String(data.get("accountId") || "");
    if (!amount || amount <= 0 || !accountId) {
      setToast("Indiquez un montant et un compte valides.");
      return;
    }
    const existing = editingRecurringId ? recurringExpenses.find((item) => item.id === editingRecurringId) : undefined;
    const recurring: RecurringExpense = {
      id: editingRecurringId || `local-recurring-${Date.now()}`,
      label: String(data.get("label") || "Charge récurrente").trim(),
      amount,
      category: String(data.get("category") || "Charges"),
      accountId,
      day: Math.min(28, Math.max(1, Number(data.get("day")) || 1)),
      startDate: String(data.get("startDate") || new Date().toISOString().slice(0, 10)),
      active: data.get("active") !== "false",
    };
    if (!user) {
      setRecurringExpenses((current) => existing ? current.map((item) => item.id === existing.id ? recurring : item) : [...current, recurring]);
      setEditingRecurringId(null);
      setModal(null);
      setToast(existing ? "Charge récurrente modifiée." : "Charge récurrente programmée.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      await setDoc(doc(db, "households", householdId, "recurringExpenses", recurring.id), {
        label: recurring.label,
        amount: recurring.amount,
        category: recurring.category,
        accountId: recurring.accountId,
        day: recurring.day,
        startDate: recurring.startDate,
        active: recurring.active,
        ...(existing ? {} : { createdAt: Timestamp.now() }),
      }, { merge: true });
      setEditingRecurringId(null);
      setModal(null);
      setToast(existing ? "Charge récurrente modifiée." : "Charge récurrente programmée.");
    } catch (error) {
      console.error("Enregistrement de la charge récurrente impossible", error);
      setToast("La charge récurrente n’a pas pu être enregistrée.");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteRecurringExpense = async (item: RecurringExpense) => {
    if (!window.confirm(`Supprimer la charge récurrente « ${item.label} » ?`)) return;
    if (!user) {
      setRecurringExpenses((current) => current.filter((entry) => entry.id !== item.id));
      setToast("Charge récurrente supprimée.");
      return;
    }
    if (!db || !householdId) return;
    try {
      await deleteDoc(doc(db, "households", householdId, "recurringExpenses", item.id));
      setToast("Charge récurrente supprimée.");
    } catch (error) {
      console.error("Suppression de la charge récurrente impossible", error);
      setToast("Impossible de supprimer cette charge récurrente.");
    }
  };

  const deleteGoal = async (goal: Goal) => {
    if (!window.confirm(`Supprimer le projet « ${goal.name} » ?`)) return;
    if (!user) {
      setGoals((current) => current.filter((item) => item.id !== goal.id));
      setToast("Projet supprimé.");
      return;
    }
    if (!db || !householdId) return;
    try {
      await deleteDoc(doc(db, "households", householdId, "goals", goal.id));
      setToast("Projet supprimé.");
    } catch (error) {
      console.error("Suppression du projet impossible", error);
      setToast("Impossible de supprimer ce projet.");
    }
  };

  const saveMonthlyBudget = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const value = Number(String(data.get("monthlyBudget")).replace(",", "."));
    if (!value || value <= 0) {
      setToast("Indiquez un budget mensuel supérieur à zéro.");
      return;
    }
    setMonthlyBudget(value);
    if (user && db && householdId) {
      await setDoc(doc(db, "households", householdId), { monthlyBudget: value }, { merge: true });
    }
    setModal(null);
    setToast("Budget mensuel mis à jour.");
  };

  const openBudgetPlanEditor = (plan?: BudgetPlan) => {
    setEditingBudgetPlanId(plan?.id || null);
    setBudgetPlanScopeDraft(plan?.scope || budgetViewScope);
    setBudgetPlanPeriodDraft(plan?.period || budgetViewPeriod);
    setModal("budgetPlan");
  };

  const saveBudgetPlan = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const type = String(data.get("type") || "expense") as TransactionType;
    const scope = String(data.get("scope") || budgetPlanScopeDraft) as BudgetPlanScope;
    const period = String(data.get("period") || budgetPlanPeriodDraft);
    const reason = String(data.get("reason") || "");
    const amount = Number(String(data.get("amount") || "").replace(",", "."));
    const periodIsValid = scope === "monthly" ? /^\d{4}-\d{2}$/.test(period) : /^\d{4}$/.test(period);
    if (!reason || !periodIsValid || !amount || amount <= 0) {
      setToast("Indiquez un motif, une période et un montant valides.");
      return;
    }
    const existing = editingBudgetPlanId ? budgetPlans.find((item) => item.id === editingBudgetPlanId) : undefined;
    const plan: BudgetPlan = {
      id: editingBudgetPlanId || `local-budget-${Date.now()}`,
      type,
      scope,
      period,
      reason,
      amount,
      createdBy: existing?.createdBy || user?.uid || "demo",
    };
    if (!user) {
      setBudgetPlans((current) => existing ? current.map((item) => item.id === existing.id ? plan : item) : [...current, plan]);
      setBudgetViewScope(scope);
      setBudgetViewPeriod(period);
      setEditingBudgetPlanId(null);
      setModal(null);
      setToast(existing ? "Budget prévisionnel modifié." : "Budget prévisionnel ajouté.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      await setDoc(doc(db, "households", householdId, "budgetPlans", plan.id), {
        type: plan.type || "expense",
        scope: plan.scope,
        period: plan.period,
        reason: plan.reason,
        amount: plan.amount,
        createdBy: plan.createdBy,
        ...(existing ? {} : { createdAt: Timestamp.now() }),
      }, { merge: true });
      setBudgetViewScope(scope);
      setBudgetViewPeriod(period);
      setEditingBudgetPlanId(null);
      setModal(null);
      setToast(existing ? "Budget prévisionnel modifié." : "Budget prévisionnel ajouté.");
    } catch (error) {
      console.error("Enregistrement du budget prévisionnel impossible", error);
      setToast("Le budget prévisionnel n’a pas pu être enregistré.");
    } finally {
      setIsSaving(false);
    }
  };

  const deleteBudgetPlan = async (plan: BudgetPlan) => {
    if (!window.confirm(`Supprimer le budget « ${plan.reason} » ?`)) return false;
    if (!user) {
      setBudgetPlans((current) => current.filter((item) => item.id !== plan.id));
      setToast("Budget prévisionnel supprimé.");
      return true;
    }
    if (!db || !householdId) return false;
    try {
      await deleteDoc(doc(db, "households", householdId, "budgetPlans", plan.id));
      setToast("Budget prévisionnel supprimé.");
      return true;
    } catch (error) {
      console.error("Suppression du budget prévisionnel impossible", error);
      setToast("Le budget prévisionnel n’a pas pu être supprimé.");
      return false;
    }
  };

  const toggleVisibleReason = async (type: TransactionType, label: string) => {
    const next: VisibleReasons = {
      ...visibleReasons,
      [type]: visibleReasons[type].includes(label)
        ? visibleReasons[type].filter((item) => item !== label)
        : [...visibleReasons[type], label],
    };
    if (!next[type].length) {
      setToast("Gardez au moins une catégorie visible dans ce menu.");
      return;
    }
    setVisibleReasons(next);
    if (user && db && householdId) {
      try {
        await setDoc(doc(db, "households", householdId), { visibleReasons: next }, { merge: true });
      } catch (error) {
        console.error("Enregistrement des catégories visibles impossible", error);
        setToast("Les catégories visibles n’ont pas pu être enregistrées.");
      }
    }
  };

  const inviteMember = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user || !db || !householdId) {
      setModal("auth");
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("memberEmail") || "").trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setToast("Indiquez une adresse e-mail valide.");
      return;
    }
    if (memberEmails.includes(email)) {
      setToast("Cette personne fait déjà partie du foyer ou a déjà été invitée.");
      return;
    }

    setIsSaving(true);
    try {
      await setDoc(doc(db, "households", householdId), {
        memberEmails: arrayUnion(email),
      }, { merge: true });
      form.reset();
      setToast(`Invitation enregistrée pour ${email}. Elle rejoindra le foyer à sa prochaine connexion.`);
    } catch (error) {
      console.error("Invitation du membre impossible", error);
      setToast("Cette personne n’a pas pu être ajoutée au foyer.");
    } finally {
      setIsSaving(false);
    }
  };

  const resetData = async () => {
    if (!user) {
      const resetAccounts = demoAccounts.map((account) => ({ ...account, balance: 0 }));
      setTransactions([]);
      setGoals([]);
      setRecurringExpenses([]);
      setAccounts(resetAccounts);
      setMonthlyBudget(0);
      window.localStorage.setItem("smart-budget-demo", JSON.stringify({
        accounts: resetAccounts,
        transactions: [],
        goals: [],
        recurringExpenses: [],
        monthlyBudget: 0,
      }));
      setModal(null);
      setToast("Toutes les données ont été remises à zéro.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const referencesToDelete = [
        ...allVisibleTransactions.map((item) => doc(db, "households", householdId, "transactions", item.id)),
        ...goals.map((goal) => doc(db, "households", householdId, "goals", goal.id)),
        ...budgetPlans.map((plan) => doc(db, "households", householdId, "budgetPlans", plan.id)),
        ...recurringExpenses.map((item) => doc(db, "households", householdId, "recurringExpenses", item.id)),
      ];
      for (const referenceChunk of chunkItems(referencesToDelete)) {
        const batch = writeBatch(db);
        referenceChunk.forEach((reference) => batch.delete(reference));
        await batch.commit();
      }
      for (const accountChunk of chunkItems(visibleAccounts)) {
        const batch = writeBatch(db);
        accountChunk.forEach((account) => {
          batch.update(doc(db, "households", householdId, "accounts", account.id), {
            balance: 0,
            balanceVerifiedAt: Timestamp.now(),
            balanceHistory: arrayUnion({ date: new Date().toISOString().slice(0, 10), balance: 0 }),
          });
        });
        await batch.commit();
      }
      await setDoc(doc(db, "households", householdId), { monthlyBudget: 0 }, { merge: true });
      setTransactions((current) => current.filter((item) => !visibleIds.has(item.accountId)));
      setGoals([]);
      setBudgetPlans([]);
      setRecurringExpenses([]);
      setAccounts((current) => current.map((account) => visibleIds.has(account.id) ? { ...account, balance: 0 } : account));
      setMonthlyBudget(0);
      setModal(null);
      setToast("Vos opérations, projets, soldes et votre budget ont été remis à zéro.");
    } catch (error) {
      console.error("Remise à zéro impossible", error);
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code || "") : "";
      setToast(code.includes("permission-denied")
        ? "Remise à zéro refusée par les règles Firestore. Vérifiez que vous êtes membre du foyer."
        : "La remise à zéro n’a pas pu être effectuée. Vérifiez votre connexion puis réessayez.");
    } finally {
      setIsSaving(false);
    }
  };

  const importCsv = async () => {
    if (!csvPreview.length) return;
    const accountId = csvAccountId;
    const account = visibleAccounts.find((item) => item.id === accountId);
    if (!account) {
      setToast("Sélectionnez le compte concerné par ce relevé.");
      return;
    }
    if (account.type === "Carte" && !csvDebitDate) {
      setToast("Indiquez la date à laquelle la carte sera débitée.");
      return;
    }
    if (!csvCustomBalanceIsValid) {
      setToast("Indiquez un solde valide après l’import.");
      return;
    }
    const rowsToImport = csvRowsToImport;
    const importedCount = rowsToImport.length;
    if (!rowsToImport.length) {
      closeCsvImport();
      setToast("Toutes les opérations du relevé existent déjà : aucun doublon n’a été ajouté.");
      return;
    }
    if (rowsToImport.length > 450) {
      setToast("Ce relevé contient plus de 450 nouvelles opérations. Découpez-le en plusieurs fichiers pour garantir un import fiable.");
      return;
    }
    const nextBalance = csvBalanceMode === "calculate"
      ? Number(account.balance || 0) + csvImpact
      : csvBalanceMode === "custom"
        ? parsedCsvCustomBalance
        : null;
    if (!user) {
      const importedAt = Date.now();
      const rows = rowsToImport.map((row, index) => ({
        ...row,
        id: `local-csv-${importedAt}-${index}`,
        importBatchId: `demo-import-${importedAt}`,
        originalLabel: row.originalLabel || row.label,
        accountId,
        ...(selectedCsvAccount?.type === "Carte" && csvDebitDate ? { debitDate: csvDebitDate } : {}),
        createdBy: "demo",
      }));
      setTransactions((current) => [...rows, ...current]);
      if (nextBalance !== null) {
        setAccounts((current) => current.map((item) => item.id === accountId ? { ...item, balance: nextBalance } : item));
      }
      setLastImport({
        transactionIds: rows.map((row) => row.id),
        accountId,
        impact: csvImpact,
        balanceMode: csvBalanceMode,
        previousBalance: Number(account.balance || 0),
      });
      closeCsvImport();
      setToast(`${rows.length} opérations importées en mode découverte.`);
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      const importBatchId = `import-${Date.now()}-${user.uid}`;
      const importedIds: string[] = [];
      rowsToImport.forEach((row) => {
        const { id: temporaryId, ...transaction } = row;
        void temporaryId;
        const reference = doc(collection(db, "households", householdId, "transactions"));
        importedIds.push(reference.id);
        batch.set(reference, { ...transaction, importBatchId, originalLabel: transaction.originalLabel || transaction.label, accountId, ...(selectedCsvAccount?.type === "Carte" && csvDebitDate ? { debitDate: csvDebitDate } : {}), createdBy: user.uid, imported: true, createdAt: Timestamp.now() });
      });
      if (csvBalanceMode === "calculate") {
        batch.update(doc(db, "households", householdId, "accounts", accountId), {
          balance: increment(csvImpact),
          balanceVerifiedAt: deleteField(),
        });
      } else if (csvBalanceMode === "custom") {
        batch.update(doc(db, "households", householdId, "accounts", accountId), {
          balance: parsedCsvCustomBalance,
          balanceHistory: arrayUnion({ date: new Date().toISOString().slice(0, 10), balance: parsedCsvCustomBalance }),
          balanceVerifiedAt: Timestamp.now(),
        });
      }
      await batch.commit();
      setLastImport({
        transactionIds: importedIds,
        accountId,
        impact: csvImpact,
        balanceMode: csvBalanceMode,
        previousBalance: Number(account.balance || 0),
      });
      closeCsvImport();
      setToast(`${importedCount} opérations importées dans ${account.name}.`);
    } catch (error) {
      console.error("Import CSV impossible", error);
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code || "") : "";
      setToast(code.includes("permission-denied")
        ? "Import refusé par les règles Firestore. Vérifiez que ce compte est visible pour vous."
        : "Le relevé bancaire n’a pas pu être importé. Vérifiez votre connexion puis réessayez.");
    } finally {
      setIsSaving(false);
    }
  };

  const undoLastImport = async () => {
    if (!lastImport) return;
    const importedIds = new Set(lastImport.transactionIds);
    if (!user) {
      setTransactions((current) => current.filter((transaction) => !importedIds.has(transaction.id)));
      if (lastImport.balanceMode !== "keep") {
        setAccounts((current) => current.map((account) => account.id === lastImport.accountId ? { ...account, balance: lastImport.previousBalance } : account));
      }
      setLastImport(null);
      setToast("Le dernier import a été annulé.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      lastImport.transactionIds.forEach((id) => batch.delete(doc(db, "households", householdId, "transactions", id)));
      if (lastImport.balanceMode === "calculate") {
        batch.update(doc(db, "households", householdId, "accounts", lastImport.accountId), {
          balance: increment(-lastImport.impact),
          balanceVerifiedAt: deleteField(),
        });
      } else if (lastImport.balanceMode === "custom") {
        batch.update(doc(db, "households", householdId, "accounts", lastImport.accountId), {
          balance: lastImport.previousBalance,
          balanceVerifiedAt: deleteField(),
        });
      }
      await batch.commit();
      setLastImport(null);
      setToast("Le dernier import a été annulé et le solde restauré.");
    } catch (error) {
      console.error("Annulation de l’import impossible", error);
      setToast("Le dernier import n’a pas pu être annulé.");
    } finally {
      setIsSaving(false);
    }
  };

  const editingTransaction = editingTransactionId ? transactions.find((item) => item.id === editingTransactionId) : undefined;
  const editingAccount = editingAccountId ? accounts.find((item) => item.id === editingAccountId) : undefined;
  const editingGoal = editingGoalId ? goals.find((item) => item.id === editingGoalId) : undefined;

  const renderUndoHistoryPanel = (compact = false) => (
    <section className={`undo-history-panel card ${compact ? "undo-history-panel-compact" : ""}`} aria-label="Dernières modifications annulables">
      <div className="panel-head">
        <div><h2 className="panel-title">Dernières modifications</h2><p className="muted">Annulez rapidement une dépense ou un revenu ajouté pour test.</p></div>
        {undoHistory.length > 0 && <span className="undo-history-count">{undoHistory.length}</span>}
      </div>
      {undoHistory.length ? (
        <div className="undo-history-list">
          {undoHistory.map((item) => (
            <div className="undo-history-row" key={item.id}>
              <div>
                <strong>{undoHistoryTitle(item)}</strong>
                <span>{undoHistoryAmount(item)} · {new Date(item.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <button className="btn btn-soft" disabled={isSaving} onClick={() => void undoHistoryItem(item)}>Annuler</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state undo-history-empty">Aucune modification annulable pour cette session.</div>
      )}
    </section>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">S</span><span>Smart Budget</span></div>
        <div className="household-pill"><small>Espace du foyer</small><strong>{user ? "Mon foyer" : "Foyer Démo"}</strong></div>
        <nav className="nav" aria-label="Navigation principale">
          {navigationItems.map(([icon, label]) => (
            <button key={label} className={activeNav === label ? "active" : ""} onClick={() => setActiveNav(label)}>
              <span className="nav-icon">{icon}</span><span className="nav-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="secure-note">▣ Vos comptes personnels restent visibles uniquement par vous.</div>
          <div className="profile-mini">
            <span className="avatar">{(user?.displayName || user?.email || "D").slice(0, 1).toUpperCase()}</span>
            <div><strong>{user?.displayName || "Mode découverte"}</strong><div className="muted">{user?.email || "Données d’exemple"}</div></div>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <h1>{activeNav}</h1>
          </div>
          <div className="top-actions">
            <select className="period-select" aria-label="Période" value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}>
              {[...monthlyData].reverse().map((month) => (
                <option key={month.key} value={month.key}>{month.label} {month.key.slice(0, 4)}</option>
              ))}
            </select>
            {user ? (
              <button className="btn btn-soft" onClick={() => auth && signOut(auth)}>Déconnexion</button>
            ) : (
              <button className="btn btn-soft" onClick={() => setModal("auth")}>Se connecter</button>
            )}
            <button className="btn btn-primary btn-add-expense" onClick={() => openQuickExpense()}>＋ Ajouter une dépense</button>
          </div>
        </header>

        {activeNav === "Vue d’ensemble" && (
          <>
        {!user && (
          <div className="goals-banner card" style={{ marginTop: 0, marginBottom: 18 }}>
            <div><strong>Explorez Smart Budget avec des données d’exemple.</strong><p>Créez votre compte pour connecter votre propre foyer et conserver vos données.</p></div>
            <button className="btn btn-lime" onClick={() => { setAuthMode("signup"); setModal("auth"); }}>Créer mon espace</button>
          </div>
        )}

        <section id="mobile-operation" className="mobile-operation-card card" aria-label="Ajouter une opération">
          <div className="mobile-operation-head">
            <div><h2 className="panel-title">Ajouter une opération</h2><p>Une dépense ou un revenu en quelques secondes.</p></div>
            <span className="quick-badge">Rapide</span>
          </div>
          <form onSubmit={addTransaction} className="mobile-operation-form">
            <div className="segmented">
              <button type="button" className={transactionType === "expense" ? "active" : ""} onClick={() => chooseOperationType("expense")}>Dépense</button>
              <button type="button" className={transactionType === "income" ? "active" : ""} onClick={() => chooseOperationType("income")}>Revenu</button>
            </div>
            <label className="label amount-label">
              Montant
              <span className="amount-wrap"><input id="mobile-amount" className="field amount-input" name="amount" inputMode="decimal" placeholder="0,00" required /><b>€</b></span>
            </label>
            <label className="label">
              Motif {transactionType === "expense" ? "de la dépense" : "du revenu"}
              <select className="field" name="reason" value={selectedReason} onChange={(event) => chooseReason(event.target.value)}>
                {availableReasons(transactionType).map((reason) => <option key={reason.label}>{reason.label}</option>)}
              </select>
            </label>
            {selectedReason.startsWith("Autre") && <label className="label">Précision<input className="field" name="customReason" value={customReason} onChange={(event) => setCustomReason(event.target.value)} placeholder="Ex. Cadeau, remboursement…" required /></label>}
            {needsPersonDetail(selectedReason) && <label className="label">Personne concernée<input className="field" name="person" value={operationPerson} onChange={(event) => setOperationPerson(event.target.value)} placeholder="Marion ou Philippe" required /></label>}
            <div className="category-auto"><span>{categoryIcons[selectedCategory] || "•"}</span> Catégorie automatique : <strong>{selectedCategory}</strong></div>
            <div className="form-grid expense-details">
              <label className="label">Compte<select className="field" name="accountId">{visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
              <label className="label">Date<input className="field" type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
            </div>
            <button className="btn btn-primary mobile-save-operation" disabled={isSaving}>{isSaving ? "Enregistrement…" : transactionType === "expense" ? "Enregistrer la dépense" : "Enregistrer le revenu"}</button>
          </form>
        </section>

        <section className="budget-usage card" aria-label={`${budgetUsage} pour cent du budget utilisé`}>
          <div className="budget-usage-head">
            <div><strong>Budget utilisé</strong><span>{money.format(expenses)} sur {money.format(monthlyBudget)}</span></div>
            <div className="budget-score"><b>{budgetUsage} %</b><button className="text-button" onClick={() => setModal("budget")}>Modifier</button></div>
          </div>
          <div className="budget-usage-track"><span style={{ width: `${budgetUsage}%` }} /></div>
          <div className="budget-usage-foot"><span>Reste disponible ce mois</span><strong>{money.format(remainingBudget)}</strong></div>
        </section>

        <section className="summary-grid" aria-label="Résumé du budget">
          <SummaryCard label="Solde disponible" value={balance} note="Voir le détail des comptes" accent="var(--green)" onClick={() => setActiveNav("Comptes")} />
          <SummaryCard label="Revenus ce mois" value={income} note="Voir les revenus enregistrés" accent="var(--mint)" onClick={() => { setTransactionFilter("income"); setActiveNav("Transactions"); }} />
          <SummaryCard label="Dépenses ce mois" value={expenses} note="Voir les dépenses enregistrées" accent="var(--coral)" onClick={() => { setTransactionFilter("expense"); setActiveNav("Transactions"); }} />
        </section>

        <section className={`cash-forecast card ${cashForecast < 0 ? "forecast-risk" : ""}`} aria-label="Prévision de trésorerie">
          <div className="cash-forecast-main"><span className="cash-forecast-icon">↗</span><div><span>Solde prévisionnel en fin de période</span><strong>{money.format(cashForecast)}</strong><small>Solde actuel + {money.format(expectedIncomeRemaining)} de revenus attendus − {money.format(expectedExpensesRemaining)} de dépenses restantes</small></div></div>
          <div className="budget-alert-panel">
            <div className="budget-alert-heading"><span>Alertes budgétaires</span><b>{budgetAlerts.length}</b></div>
            <div className="budget-alerts" aria-label="Alertes budgétaires">
              {budgetAlerts.length ? budgetAlerts.map((alert) => <button key={alert} onClick={() => alert.includes("budget") ? setActiveNav("Analyse") : alert.includes("vérifier") ? setActiveNav("Transactions") : undefined}>⚠ {alert}</button>) : <span className="all-clear">✓ Aucun point d’attention pour cette période</span>}
            </div>
          </div>
        </section>

        {renderUndoHistoryPanel(true)}

        <section className="analysis-grid" aria-label="Analyse du budget">
          <button className="analysis-card" onClick={() => { setTransactionFilter("review"); setActiveNav("Transactions"); }}><span>À vérifier</span><strong>{reviewCount}</strong><small>Opérations dont la catégorie est incertaine</small></button>
          <article className="analysis-card"><span>Charges récurrentes</span><strong>{money.format(recurringTotal)}</strong><small>Ce mois</small></article>
          <article className="analysis-card"><span>Catégorie principale</span><strong>{categoryData[0]?.label || "—"}</strong><small>{categoryData[0] ? money.format(categoryData[0].value) : "Ajoutez une dépense"}</small></article>
          <article className="analysis-card"><span>Commerçant principal</span><strong>{merchantData[0]?.[0] || "—"}</strong><small>{merchantData[0] ? money.format(merchantData[0][1]) : "Aucune donnée"}</small></article>
        </section>

        <section className="dashboard-grid">
          <article className="card panel">
            <div className="panel-head"><h2 className="panel-title">Où part votre argent ?</h2><button className="text-button" onClick={() => setActiveNav("Transactions")}>Voir le détail →</button></div>
            <div className="chart-wrap">
              <div className="donut" style={{ background: donutBackground }} aria-label="Répartition des dépenses par catégorie"><span>{budgetUsage} %<small>du budget</small></span></div>
              <div className="legend">
                {categoryData.length ? categoryData.slice(0, 6).map((item) => (
                  <div className="legend-row" key={item.label}><span className="legend-color" style={{ background: item.color }} /><span>{item.label}</span><strong>{money.format(item.value)}</strong></div>
                )) : <div className="empty-chart">Ajoutez une dépense pour voir sa répartition.</div>}
              </div>
            </div>
          </article>

          <article className="card panel">
            <div className="panel-head"><h2 className="panel-title">Mes comptes</h2><button className="text-button" onClick={() => openAccountEditor()}>＋ Ajouter</button></div>
            <div className="account-list">
              {visibleAccounts.slice(0, 4).map((account) => (
                <div className="account-row" key={account.id}>
                  <span className="account-icon">{account.type === "Épargne" ? "🎯" : account.type === "Carte" ? "💳" : "🏦"}</span>
                  <div><div className="account-name">{account.name}</div><div className="account-meta">{account.type === "Carte" ? "Carte à débit différé" : account.type}</div>{account.type === "Carte" && account.debitAccountId && <span className="deferred-card-pill">Débit sur {visibleAccounts.find((item) => item.id === account.debitAccountId)?.name || "compte lié"}</span>}{account.visibility === "private" && <span className="privacy-pill">● privé</span>}</div>
                  <div className="account-side"><div className="account-amount">{money.format(Number(account.balance || 0))}</div><span className={account.balanceVerifiedAt ? "balance-status verified" : "balance-status"}>{balanceVerificationLabel(account.balanceVerifiedAt)}</span><button className="mini-action" onClick={() => openAccountEditor(account)}>Compte / solde</button>{account.balanceHistory?.slice(-3).map((entry) => <small className="muted" key={`${account.id}-${entry.date}`}>{entry.date} · {money.format(entry.balance)}</small>)}</div>
                </div>
              ))}
            </div>
            {deferredCardSummaries.map(({ account, pending, nextDebitDate, debitAccount }) => <div className="deferred-card-summary" key={`deferred-${account.id}`}><div><strong>💳 Encours carte</strong><span className="muted">{account.name}{debitAccount ? ` · débité sur ${debitAccount.name}` : ""}</span></div><div className="deferred-card-summary-side"><b>{money.format(pending)}</b><small>{nextDebitDate ? `Prochain débit : ${fullDisplayDate.format(new Date(`${nextDebitDate}T12:00:00`))}` : "Aucune date de débit renseignée"}</small></div></div>)}
          </article>
        </section>

        <section className="card panel monthly-chart-card">
          <div className="panel-head"><div><h2 className="panel-title">Évolution des dépenses</h2><p className="muted">Comparaison des six derniers mois.</p></div><span className="budget-target">Budget : {money.format(monthlyBudget)}</span></div>
          <div className="monthly-chart" role="img" aria-label="Graphique des dépenses des six derniers mois">
            {monthlyData.map((month) => (
              <div className="month-column" key={month.key}>
                <strong>{month.total ? money.format(month.total) : "0 €"}</strong>
                <div className="month-track"><span style={{ height: `${Math.max(month.total ? 8 : 2, (month.total / monthlyMax) * 100)}%` }} /></div>
                <small>{month.label}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="card transactions">
          <div className="panel-head">
            <h2 className="panel-title">Derniers mouvements</h2>
            <div><button className="text-button" onClick={openCsvImport}>Importer un CSV</button><button className="text-button" onClick={() => setActiveNav("Transactions")}>Tout voir →</button></div>
          </div>
          <div className="transaction-list">
            {visibleTransactions.length ? visibleTransactions.slice(0, 7).map((transaction) => (
              <div className="transaction-row transaction-row-clickable" key={transaction.id} onClick={() => openTransactionEditor(transaction)}>
                <span className="transaction-icon">{categoryIcons[transaction.category] || "•"}</span>
                <div><div className="transaction-label">{transaction.label}</div><div className="muted">{visibleAccounts.find((account) => account.id === transaction.accountId)?.name || "Compte"}</div>{transaction.debitDate && <span className="deferred-debit-badge">💳 Débit le {fullDisplayDate.format(new Date(`${transaction.debitDate}T12:00:00`))}</span>}{transaction.confidence != null && transaction.confidence < 0.8 && <span className="confidence-badge">À vérifier</span>}</div>
                <div className="transaction-category">{transaction.category}</div>
                <div className="transaction-date">{displayDate.format(new Date(transaction.date))}</div>
                <div className="transaction-end"><div className={`transaction-amount ${transaction.type}`}>{transaction.type === "income" ? "+" : "−"} {money.format(transaction.amount)}</div><div className="row-actions"><button onClick={(event) => { event.stopPropagation(); openTransactionEditor(transaction); }}>Modifier</button><button className="danger-link" onClick={(event) => { event.stopPropagation(); void deleteTransaction(transaction); }}>Supprimer</button></div></div>
              </div>
            )) : <div className="empty-state">Aucun mouvement pour le moment.</div>}
          </div>
        </section>

        <section className="card goals-banner">
          <div>
            <h2 className="panel-title">Projets à venir</h2>
            <p>Anticipez les grandes dépenses sans déséquilibrer le budget du mois.</p>
            <div className="goal-list" style={{ marginTop: 14 }}>
              {goals.slice(0, 2).map((goal) => (
                <div className="goal-row" key={goal.id}>
                  <div className="goal-title-row"><strong>{goal.name}</strong><span>{money.format(goal.saved)} / {money.format(goal.target)}</span></div>
                  <div className="progress"><span style={{ width: `${Math.min(100, (goal.saved / goal.target) * 100)}%` }} /></div>
                  <div className="goal-footer"><div className="muted">{money.format(goal.monthly)} / mois conseillé</div><div className="row-actions"><button onClick={() => openGoalEditor(goal)}>Modifier</button><button className="danger-link" onClick={() => deleteGoal(goal)}>Supprimer</button></div></div>
                </div>
              ))}
            </div>
          </div>
          <button className="btn btn-lime" onClick={() => openGoalEditor()}>＋ Nouveau projet</button>
        </section>
          </>
        )}

        {activeNav === "Transactions" && (
          <section className="card transactions view-section">
            <div className="panel-head">
              <div><h2 className="panel-title">Toutes les opérations</h2><p className="muted">Dépenses et revenus de la période sélectionnée.</p></div>
              <div className="view-actions"><button className="btn btn-soft" onClick={openCsvImport}>Importer un CSV</button><button className="btn btn-soft" onClick={() => openRecurringEditor()}>＋ Charge mensuelle</button><button className="btn btn-primary" onClick={() => openQuickExpense()}>＋ Ajouter</button></div>
            </div>
            <div className="transaction-filters" role="group" aria-label="Filtrer les opérations">
              {(["all", "expense", "income", "review"] as TransactionFilter[]).map((filter) => <button key={filter} className={transactionFilter === filter ? "active" : ""} onClick={() => setTransactionFilter(filter)}>{filter === "all" ? "Tout" : filter === "expense" ? "Dépenses" : filter === "income" ? "Revenus" : "À vérifier"}</button>)}
            </div>
            <div className="transaction-searchbar">
              <label className="label search-field">Rechercher<input className="field" type="search" value={transactionSearch} onChange={(event) => setTransactionSearch(event.target.value)} placeholder="Libellé, motif ou catégorie…" /></label>
              <label className="label">Compte<select className="field" value={transactionAccountFilter} onChange={(event) => setTransactionAccountFilter(event.target.value)}><option value="all">Tous les comptes</option>{visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
              <label className="label">Catégorie<select className="field" value={transactionCategoryFilter} onChange={(event) => setTransactionCategoryFilter(event.target.value)}><option value="all">Toutes les catégories</option>{transactionCategories.map((category) => <option key={category}>{category}</option>)}</select></label>
              {(transactionSearch || transactionAccountFilter !== "all" || transactionCategoryFilter !== "all") && <button className="btn btn-soft clear-filters" onClick={() => { setTransactionSearch(""); setTransactionAccountFilter("all"); setTransactionCategoryFilter("all"); }}>Effacer</button>}
            </div>
            {lastImport && <div className="undo-import-banner"><div><strong>Dernier import disponible</strong><span>{lastImport.transactionIds.length} opération(s) peuvent encore être retirées.</span></div><button className="btn btn-soft" disabled={isSaving} onClick={() => void undoLastImport()}>Annuler le dernier import</button></div>}
            {renderUndoHistoryPanel(true)}
            <div className="bulk-actions"><label><input type="checkbox" checked={visibleTransactions.length > 0 && visibleTransactions.every((transaction) => selectedTransactionIds.has(transaction.id))} onChange={toggleAllVisibleTransactions} /> Tout sélectionner</label>{selectedTransactionIds.size > 0 && <><span>{selectedTransactionIds.size} opération(s) sélectionnée(s)</span><select className="field" defaultValue="" onChange={(event) => { void applyBulkCategory(event.target.value); event.currentTarget.value = ""; }} disabled={isSaving}><option value="">Attribuer le même motif…</option>{[...new Map([...operationReasons.expense, ...operationReasons.income].map((reason) => [reason.label, reason])).values()].map((reason) => <option key={`${reason.label}-${reason.category}`} value={reason.label}>{reason.label} · {reason.category}</option>)}</select></>}</div>
            <div className="transaction-list">
              {visibleTransactions.length ? visibleTransactions.map((transaction) => (
                <div className="transaction-row transaction-row-clickable" key={transaction.id} onClick={() => openTransactionEditor(transaction)}>
                  <div className="transaction-select-cell"><input type="checkbox" checked={selectedTransactionIds.has(transaction.id)} onClick={(event) => event.stopPropagation()} onChange={() => toggleTransactionSelection(transaction.id)} aria-label={`Sélectionner ${transaction.label}`} /><span className="transaction-icon">{categoryIcons[transaction.category] || "•"}</span></div>
                  <div><div className="transaction-label">{transaction.label}</div><div className="muted">{visibleAccounts.find((account) => account.id === transaction.accountId)?.name || "Compte"}</div>{transaction.debitDate && <span className="deferred-debit-badge">💳 Débit le {fullDisplayDate.format(new Date(`${transaction.debitDate}T12:00:00`))}</span>}{transaction.confidence != null && transaction.confidence < 0.8 && <span className="confidence-badge">À vérifier</span>}</div>
                  <div className="transaction-category">{transaction.category}</div>
                  <div className="transaction-date">{displayDate.format(new Date(transaction.date))}</div>
                  <div className="transaction-end"><div className={`transaction-amount ${transaction.type}`}>{transaction.type === "income" ? "+" : "−"} {money.format(transaction.amount)}</div><div className="row-actions"><button onClick={(event) => { event.stopPropagation(); openTransactionEditor(transaction); }}>Modifier</button><button className="danger-link" onClick={(event) => { event.stopPropagation(); void deleteTransaction(transaction); }}>Supprimer</button></div></div>
                </div>
              )) : <div className="empty-state">Aucune opération pour cette période.</div>}
            </div>
            <div className="recurring-list">
              <div className="panel-head"><div><h3 className="panel-title">Charges récurrentes</h3><p className="muted">Les prélèvements actifs sont générés chaque mois.</p></div><button className="text-button" onClick={() => openRecurringEditor()}>＋ Ajouter</button></div>
              {recurringExpenses.length ? recurringExpenses.map((item) => <div className="recurring-row" key={item.id}><div><strong>{item.label}</strong><span className="muted">{money.format(item.amount)} · le {item.day} de chaque mois</span></div><div className="row-actions"><button onClick={() => openRecurringEditor(item)}>Modifier</button><button className="danger-link" onClick={() => deleteRecurringExpense(item)}>Supprimer</button></div></div>) : <div className="empty-state">Aucune charge récurrente programmée.</div>}
            </div>
          </section>
        )}

        {activeNav === "Budgets" && (
          <section className="card panel view-section budget-plans-page">
            <div className="panel-head">
              <div><h2 className="panel-title">Budget prévisionnel</h2><p className="muted">Préparez les revenus et les dépenses. Les lignes sont reportées automatiquement sur les autres mois.</p></div>
              <button className="btn btn-primary" onClick={() => openBudgetPlanEditor()}>＋ Ajouter un budget</button>
            </div>
            <div className="budget-view-toolbar">
              <div className="segmented budget-scope-switch"><button className={budgetViewScope === "monthly" ? "active" : ""} onClick={() => { setBudgetViewScope("monthly"); setBudgetViewPeriod(selectedPeriod); }}>Mensuel</button><button className={budgetViewScope === "annual" ? "active" : ""} onClick={() => { setBudgetViewScope("annual"); setBudgetViewPeriod(selectedPeriod.slice(0, 4)); }}>Annuel</button></div>
              <label className="label budget-period-field">{budgetViewScope === "monthly" ? "Mois" : "Année"}<input className="field" type={budgetViewScope === "monthly" ? "month" : "number"} min={budgetViewScope === "annual" ? "2020" : undefined} max={budgetViewScope === "annual" ? "2100" : undefined} value={budgetViewPeriod} onChange={(event) => setBudgetViewPeriod(event.target.value)} /></label>
            </div>
            <div className="budget-kpi-grid budget-kpi-grid-four"><article className="analysis-card"><span>Revenus prévus</span><strong>{money.format(plannedIncomeTotal)}</strong><small>Réel : {money.format(plannedIncomeActual)}</small></article><article className="analysis-card"><span>Charges prévues</span><strong>{money.format(plannedBudgetTotal)}</strong><small>Réel : {money.format(plannedBudgetSpent)}</small></article><article className="analysis-card living-remainder-card"><span>Reste à vivre</span><strong>{money.format(plannedLivingRemainder)}</strong><small>Revenus prévus − charges prévues</small></article><article className="analysis-card reserve-card"><span>Marge après dépassements</span><strong>{money.format(livingReserveRemaining)}</strong><small>{money.format(plannedLivingRemainder)} − {money.format(livingReserveUsed)} de dépassements</small></article></div>
            <div className="budget-tables-grid">
              <article className="budget-table-card"><div className="panel-head"><div><h3 className="panel-title">Revenus prévisionnels</h3><p className="muted">Les entrées attendues sur la période.</p></div></div><div className="budget-table-scroll"><table className="budget-table"><thead><tr><th>Motif</th><th>Prévu</th><th>Réel</th><th>Écart</th></tr></thead><tbody>{incomeBudgetProgress.length ? incomeBudgetProgress.map((plan) => <tr className="budget-table-row-clickable" tabIndex={0} role="button" onClick={() => openBudgetPlanEditor(plan)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openBudgetPlanEditor(plan); } }} key={plan.id}><td><span className="budget-table-label"><span className="budget-plan-icon">{categoryIcons[operationReasons.income.find((item) => item.label === plan.reason)?.category || plan.reason] || "💶"}</span>{plan.reason}</span></td><td>{money.format(plan.amount)}</td><td>{money.format(plan.spent)}</td><td className={plan.spent >= plan.amount ? "budget-positive" : "budget-negative"}>{plan.spent >= plan.amount ? "+" : "−"}{money.format(Math.abs(plan.spent - plan.amount))}</td></tr>) : <tr><td colSpan={4} className="budget-table-empty">Aucun revenu prévisionnel. Ajoutez-en un pour commencer.</td></tr>}</tbody><tfoot><tr><th>Total</th><th>{money.format(plannedIncomeTotal)}</th><th>{money.format(plannedIncomeActual)}</th><th>{money.format(plannedIncomeActual - plannedIncomeTotal)}</th></tr></tfoot></table></div></article>
              <article className="budget-table-card"><div className="panel-head"><div><h3 className="panel-title">Dépenses prévisionnelles</h3><p className="muted">Les plafonds qui alimentent les tuiles de suivi.</p></div></div><div className="budget-table-scroll"><table className="budget-table"><thead><tr><th>Motif</th><th>Prévu</th><th>Réel</th><th>Écart</th></tr></thead><tbody>{expenseBudgetProgress.length ? expenseBudgetProgress.map((plan) => <tr className={`budget-table-row-clickable ${budgetStatus(plan.percent)}`} tabIndex={0} role="button" onClick={() => openBudgetPlanEditor(plan)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openBudgetPlanEditor(plan); } }} key={plan.id}><td><span className="budget-table-label"><span className="budget-plan-icon">{categoryIcons[operationReasons.expense.find((item) => item.label === plan.reason)?.category || plan.reason] || "📌"}</span>{plan.reason}</span></td><td>{money.format(plan.amount)}</td><td>{money.format(plan.spent)}</td><td className={plan.spent <= plan.amount ? "budget-positive" : "budget-negative"}>{plan.spent <= plan.amount ? "+" : "−"}{money.format(Math.abs(plan.amount - plan.spent))}</td></tr>) : <tr><td colSpan={4} className="budget-table-empty">Aucune dépense prévisionnelle. Ajoutez un plafond par motif.</td></tr>}</tbody><tfoot><tr><th>Total</th><th>{money.format(plannedBudgetTotal)}</th><th>{money.format(plannedBudgetSpent)}</th><th>{money.format(plannedBudgetRemaining)}</th></tr></tfoot></table></div></article>
            </div>
            <div className="budget-status-legend" aria-label="Légende des couleurs"><span className="safe">● Moins de 75 %</span><span className="warning">● De 75 à 100 %</span><span className="over">● Dès 101 %</span></div>
            <div className="budget-report-note"><span className="budget-plan-icon">↻</span><span>La marge après dépassements correspond au reste à vivre prévisionnel de {money.format(plannedLivingRemainder)}, diminué des {money.format(livingReserveUsed)} déjà dépensés au-delà des budgets.</span><button className="btn btn-soft" onClick={() => setActiveNav("Analyse")}>Voir les tuiles de suivi</button></div>
          </section>
        )}

        {activeNav === "Analyse" && (
          <section className="view-section analysis-page">
            <div className="page-heading"><div><h2 className="panel-title">{selectedBudgetPlan ? `Détail du budget — ${selectedBudgetPlan.reason}` : "Suivi du budget"}</h2><p className="muted">{selectedBudgetPlan ? "Analyse détaillée du motif sélectionné." : "Les tuiles sont calculées à partir du budget prévisionnel et des opérations enregistrées."}</p></div><div className="budget-view-toolbar"><div className="segmented budget-scope-switch"><button className={budgetViewScope === "monthly" ? "active" : ""} onClick={() => { setBudgetViewScope("monthly"); setBudgetViewPeriod(selectedPeriod); }}>Mensuel</button><button className={budgetViewScope === "annual" ? "active" : ""} onClick={() => { setBudgetViewScope("annual"); setBudgetViewPeriod(selectedPeriod.slice(0, 4)); }}>Annuel</button></div><label className="label budget-period-field"><input className="field" type={budgetViewScope === "monthly" ? "month" : "number"} value={budgetViewPeriod} onChange={(event) => setBudgetViewPeriod(event.target.value)} /></label></div></div>
            <section className={`cash-forecast analysis-cash-forecast card ${cashForecast < 0 ? "forecast-risk" : ""}`} aria-label="Prévision et alertes budgétaires">
              <div className="cash-forecast-main"><span className="cash-forecast-icon">↗</span><div><span>Prévision du solde en fin de période</span><strong>{money.format(cashForecast)}</strong><small>Solde actuel + revenus encore attendus − dépenses prévisionnelles restantes</small></div></div>
              <div className="budget-alert-panel">
                <div className="budget-alert-heading"><span>Alertes budgétaires</span><b>{budgetAlerts.length}</b></div>
                <div className="budget-alerts">
                  {budgetAlerts.length ? budgetAlerts.map((alert) => <button key={alert} onClick={() => alert.includes("vérifier") ? setActiveNav("Transactions") : undefined}>⚠ {alert}</button>) : <span className="all-clear">✓ Aucun point d’attention pour cette période</span>}
                </div>
              </div>
            </section>
            {selectedBudgetPlan ? <>
              <div className="budget-detail-actions"><button className="btn btn-soft budget-back-button" onClick={() => setSelectedBudgetPlanId(null)}>← Retour aux tuiles</button><button className="btn btn-primary budget-back-button" onClick={() => openBudgetPlanEditor(selectedBudgetPlan)}>Modifier ce budget</button></div>
              <div className={`budget-detail-kpis ${budgetStatus(selectedBudgetPlan.percent)}`}><article className="analysis-card"><span>Prévu</span><strong>{money.format(selectedBudgetPlan.amount)}</strong><small>Dérivé du tableau prévisionnel</small></article><article className="analysis-card"><span>Dépensé</span><strong>{money.format(selectedBudgetPlan.spent)}</strong><small>{selectedBudgetPlan.transactions.length} opération{selectedBudgetPlan.transactions.length > 1 ? "s" : ""} reconnue{selectedBudgetPlan.transactions.length > 1 ? "s" : ""}</small></article><article className="analysis-card"><span>Disponible</span><strong>{money.format(selectedBudgetPlan.coveredRemaining)}</strong><small>{selectedBudgetPlan.reserveUsed ? `${money.format(selectedBudgetPlan.reserveUsed)} couverts par la cagnotte` : "Prévu − dépensé"}</small></article><article className="analysis-card"><span>Utilisé</span><strong>{selectedBudgetPlan.percent} %</strong><small>{selectedBudgetPlan.percent > 100 ? `Dépassé de ${money.format(selectedBudgetPlan.overrun)}` : selectedBudgetPlan.percent >= 75 ? "Budget à surveiller" : "Budget maîtrisé"}</small></article></div>
              <div className="budget-detail-grid"><article className="card panel budget-history-card"><div className="panel-head"><div><h3 className="panel-title">Évolution mensuelle</h3><p className="muted">Les dépenses comparées au plafond de {money.format(selectedBudgetPlan.amount)}.</p></div></div><div className="budget-history-chart">{budgetDetailHistory.map((entry) => <div className="budget-history-column" key={entry.period}><strong>{money.format(entry.spent)}</strong><div className="budget-history-track"><span style={{ height: `${Math.min(100, (entry.spent / Math.max(selectedBudgetPlan.amount, ...budgetDetailHistory.map((item) => item.spent), 1)) * 100)}%` }} /></div><small>{entry.label}</small></div>)}</div></article><article className={`card panel budget-donut-card ${budgetStatus(selectedBudgetPlan.percent)}`}><h3 className="panel-title">Utilisation du budget</h3><div className="budget-donut" style={{ background: `conic-gradient(${selectedBudgetPlan.percent > 100 ? "var(--danger)" : selectedBudgetPlan.percent >= 75 ? "var(--budget-warning)" : "var(--green)"} 0 ${Math.min(100, selectedBudgetPlan.percent)}%, #e8eee9 ${Math.min(100, selectedBudgetPlan.percent)}% 100%)` }}><span>{selectedBudgetPlan.percent} %<small>utilisé</small></span></div><p className="muted">{money.format(selectedBudgetPlan.spent)} dépensé sur {money.format(selectedBudgetPlan.amount)} prévus.</p></article></div>
              <article className="card panel budget-operations-detail"><div className="panel-head"><div><h3 className="panel-title">Opérations prises en compte</h3><p className="muted">Les libellés bancaires originaux sont conservés.</p></div></div>{selectedBudgetPlan.transactions.length ? <div className="budget-detail-operation-list">{selectedBudgetPlan.transactions.map((transaction) => <div className="budget-detail-operation" key={transaction.id}><span>{displayDate.format(new Date(transaction.date))}</span><div><strong>{transaction.originalLabel || transaction.label}</strong><small>{transaction.reason || transaction.category}</small></div><b>{money.format(transaction.amount)}</b></div>)}</div> : <div className="empty-state">Aucune opération reconnue sur cette période.</div>}</article>
            </> : <>
              <div className="budget-detail-kpis"><article className="analysis-card"><span>Dépenses de la période</span><strong>{money.format(budgetViewExpenses)}</strong><small>{analysisExpenseRows.length} motif(s) utilisé(s)</small></article><article className="analysis-card"><span>Revenus de la période</span><strong>{money.format(budgetViewIncome)}</strong><small>{analysisIncomeRows.length} source(s) enregistrée(s)</small></article><article className="analysis-card living-remainder-card"><span>Reste à vivre prévisionnel</span><strong>{money.format(plannedLivingRemainder)}</strong><small>Revenus prévus − charges prévues</small></article><article className="analysis-card reserve-card"><span>Marge après dépassements</span><strong>{money.format(livingReserveRemaining)}</strong><small>{money.format(plannedLivingRemainder)} − {money.format(livingReserveUsed)} de dépassements</small></article></div>
              <div className="budget-status-legend" aria-label="Légende des couleurs"><span className="safe">● Moins de 75 % — maîtrisé</span><span className="warning">● De 75 à 100 % — à surveiller</span><span className="over">● Dès 101 % — dépassé</span></div>
              <div className="budget-tile-grid">{budgetCoverage.length ? budgetCoverage.map((plan) => <button className={`budget-tile ${budgetStatus(plan.percent)}`} key={plan.id} onClick={() => setSelectedBudgetPlanId(plan.id)}><div className="budget-tile-head"><span className="budget-plan-icon">{categoryIcons[operationReasons.expense.find((item) => item.label === plan.reason)?.category || plan.reason] || "📌"}</span><span><strong>{plan.reason}</strong><small>{money.format(plan.amount)} prévus</small></span><b>{plan.percent} %</b></div><div className="budget-status-label">{plan.percent > 100 ? `Dépassé de ${money.format(plan.overrun)}` : plan.percent >= 75 ? "À surveiller" : "Budget maîtrisé"}</div><div className="budget-plan-track"><span style={{ width: Math.min(100, plan.percent) + "%" }} /></div><div className="budget-tile-foot"><span>{money.format(plan.spent)} dépensés</span><strong>{plan.reserveUsed ? `${money.format(plan.reserveUsed)} couverts` : `${money.format(plan.coveredRemaining)} disponibles`}</strong></div></button>) : <div className="empty-state">Ajoutez une dépense prévisionnelle pour créer votre première tuile de suivi.</div>}</div>
              <div className="analysis-columns"><article className="card panel"><div className="panel-head"><div><h3 className="panel-title">Où part l’argent ?</h3><p className="muted">Classement par motif précis.</p></div></div><div className="analysis-bars">{analysisExpenseRows.length ? analysisExpenseRows.map((row) => <div className="analysis-bar-row" key={row.label}><div><span>{categoryIcons[operationReasons.expense.find((item) => item.label === row.label)?.category || row.label] || "📌"} {row.label}</span><b>{money.format(row.value)}</b></div><div className="analysis-bar-track"><span style={{ width: row.percent + "%" }} /></div><small>{row.percent}% des dépenses</small></div>) : <div className="empty-state">Aucune dépense sur cette période.</div>}</div></article><article className="card panel"><div className="panel-head"><div><h3 className="panel-title">D’où viennent les revenus ?</h3><p className="muted">Répartition des entrées.</p></div></div><div className="analysis-bars">{analysisIncomeRows.length ? analysisIncomeRows.map((row) => <div className="analysis-bar-row income-bar" key={row.label}><div><span>{categoryIcons[operationReasons.income.find((item) => item.label === row.label)?.category || row.label] || "💶"} {row.label}</span><b>{money.format(row.value)}</b></div><div className="analysis-bar-track"><span style={{ width: row.percent + "%" }} /></div><small>{row.percent}% des revenus</small></div>) : <div className="empty-state">Aucun revenu sur cette période.</div>}</div></article></div>
            </>}
          </section>
        )}

        {activeNav === "Comptes" && (
          <section className="card panel view-section">
            <div className="panel-head">
              <div><h2 className="panel-title">Comptes visibles</h2><p className="muted">Les comptes personnels restent privés selon vos réglages.</p></div>
              <button className="btn btn-primary" onClick={() => openAccountEditor()}>＋ Ajouter un compte</button>
            </div>
            <div className="account-list accounts-view">
              {visibleAccounts.map((account) => (
                <div className="account-row" key={account.id}>
                  <span className="account-icon">{account.type === "Épargne" ? "🎯" : account.type === "Carte" ? "💳" : "🏦"}</span>
                  <div><div className="account-name">{account.name}</div><div className="account-meta">{account.type === "Carte" ? "Carte à débit différé" : account.type}</div>{account.type === "Carte" && account.debitAccountId && <span className="deferred-card-pill">Débit sur {visibleAccounts.find((item) => item.id === account.debitAccountId)?.name || "compte lié"}</span>}{account.visibility === "private" && <span className="privacy-pill">● privé</span>}</div>
                  <div className="account-side"><div className="account-amount">{money.format(Number(account.balance || 0))}</div><span className={account.balanceVerifiedAt ? "balance-status verified" : "balance-status"}>{balanceVerificationLabel(account.balanceVerifiedAt)}</span><button className="mini-action" onClick={() => openAccountEditor(account)}>Compte / solde</button></div>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeNav === "Projets" && (
          <section className="card goals-banner view-section">
            <div>
              <h2 className="panel-title">Dépenses futures et projets</h2>
              <p>Préparez vos vacances, travaux ou achats grâce à une mensualité conseillée.</p>
              <div className="goal-list goals-view">
                {goals.length ? goals.map((goal) => (
                  <div className="goal-row" key={goal.id}>
                    <div className="goal-title-row"><strong>{goal.name}</strong><span>{money.format(goal.saved)} / {money.format(goal.target)}</span></div>
                    <div className="progress"><span style={{ width: `${Math.min(100, (goal.saved / goal.target) * 100)}%` }} /></div>
                    <div className="goal-footer"><div className="muted">{money.format(goal.monthly)} / mois conseillé · objectif {displayDate.format(new Date(goal.dueDate))}</div><div className="row-actions"><button onClick={() => openGoalEditor(goal)}>Modifier</button><button className="danger-link" onClick={() => deleteGoal(goal)}>Supprimer</button></div></div>
                    <small className="muted goal-schedule">Échéancier : {(goal.schedule || []).slice(0, 4).map((entry) => `${entry.date} ${money.format(entry.amount)}`).join(" · ")}{(goal.schedule || []).length > 4 ? " · …" : ""}</small>
                  </div>
                )) : <div className="empty-state">Aucun projet planifié.</div>}
              </div>
            </div>
            <button className="btn btn-lime" onClick={() => openGoalEditor()}>＋ Nouveau projet</button>
          </section>
        )}

        {activeNav === "Mon foyer" && (
          <section className="card panel view-section household-view">
            <div className="profile-card">
              <span className="avatar profile-avatar">{(user?.displayName || user?.email || "D").slice(0, 1).toUpperCase()}</span>
              <div><h2 className="panel-title">{user?.displayName || "Mode découverte"}</h2><p className="muted">{user?.email || "Connectez-vous pour créer votre foyer."}</p></div>
            </div>
            <div className="household-settings">
              <div className="member-settings">
                <strong>Partage familial</strong>
                <p className="muted">Chaque membre utilise son propre accès Firebase et retrouve les données du même foyer.</p>
                {user ? (
                  <>
                    <div className="member-list">
                      {memberEmails.map((email) => <span className="member-pill" key={email}>{email}</span>)}
                    </div>
                    <form className="member-invite-form" onSubmit={inviteMember}>
                      <label className="label">Adresse e-mail du membre<input className="field" type="email" name="memberEmail" placeholder="exemple@email.com" required /></label>
                      <button className="btn btn-soft" disabled={isSaving}>{isSaving ? "Ajout…" : "Ajouter au foyer"}</button>
                    </form>
                    <small className="muted">La personne rejoindra automatiquement ce foyer lors de sa prochaine connexion avec cette adresse.</small>
                  </>
                ) : (
                  <button className="mini-action" onClick={() => setModal("auth")}>Se connecter pour ajouter un membre</button>
                )}
              </div>
              <div><strong>Confidentialité des comptes</strong><p className="muted">Un compte personnel peut rester visible uniquement par son propriétaire.</p></div>
              <div><strong>Budget mensuel</strong><p className="muted">{money.format(monthlyBudget)} · utilisé pour calculer vos pourcentages.</p><button className="mini-action" onClick={() => setModal("budget")}>Modifier le budget</button></div>
              <div className="reason-settings"><strong>Catégories visibles dans les menus</strong><p className="muted">Décochez les catégories que vous n’utilisez pas. Elles restent conservées dans vos anciennes opérations.</p><h4>Dépenses</h4><div className="reason-checkboxes">{operationReasons.expense.map((reason) => <label key={reason.label}><input type="checkbox" checked={visibleReasons.expense.includes(reason.label)} onChange={() => void toggleVisibleReason("expense", reason.label)} />{reason.label}</label>)}</div><h4>Revenus</h4><div className="reason-checkboxes">{operationReasons.income.map((reason) => <label key={reason.label}><input type="checkbox" checked={visibleReasons.income.includes(reason.label)} onChange={() => void toggleVisibleReason("income", reason.label)} />{reason.label}</label>)}</div></div>
              <div className="danger-zone"><strong>Remise à zéro</strong><p className="muted">Efface les opérations et projets, puis remet les soldes et le budget mensuel à zéro.</p><button className="btn btn-danger" onClick={() => setModal("reset")}>Remettre mes données à zéro</button></div>
            </div>
            {user ? <button className="btn btn-soft" onClick={() => auth && signOut(auth)}>Se déconnecter</button> : <button className="btn btn-primary" onClick={() => setModal("auth")}>Se connecter ou créer un compte</button>}
          </section>
        )}
      </main>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {[
          ["▦", "Vue d’ensemble"],
          ["↕", "Transactions"],
          ["＋", "Ajouter"],
          ["◫", "Budgets"],
          ["◌", "Analyse"],
          ["♙", "Mon foyer"],
        ].map(([icon, label], index) => (
          <button
            key={label}
            aria-label={label}
            className={index === 2 ? "add-mobile" : activeNav === label ? "active" : ""}
            onClick={() => index === 2 ? showMobileOperation() : setActiveNav(label)}
          >
            <span>{icon}</span><small>{label === "Vue d’ensemble" ? "Accueil" : label}</small>
          </button>
        ))}
      </nav>

      <button className="expense-fab" onClick={() => openQuickExpense()} aria-label="Ajouter rapidement une dépense">
        <span>＋</span><strong>Ajouter une dépense</strong><kbd>E</kbd>
      </button>

      {modal === "auth" && (
        <Modal title={authMode === "signin" ? "Bon retour parmi nous" : "Créez votre foyer"} onClose={() => setModal(null)}>
          <div className="auth-intro">Vos données sont protégées par Firebase. Chaque membre dispose de son propre accès.</div>
          <form onSubmit={handleAuth}>
            <div className="form-grid">
              {authMode === "signup" && <label className="label wide">Votre prénom<input className="field" name="name" required autoComplete="name" /></label>}
              <label className="label wide">Adresse e-mail<input className="field" type="email" name="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required autoComplete="email" /></label>
              <label className="label wide">Mot de passe<input className="field" type="password" name="password" minLength={6} required autoComplete={authMode === "signin" ? "current-password" : "new-password"} /></label>
            </div>
            {authError && <p style={{ color: "#b54432", fontSize: 13 }}>{authError}</p>}
            <div className="form-actions">{authMode === "signin" && <button className="text-button password-reset-button" type="button" onClick={() => void resetPassword()}>Mot de passe oublié ?</button>}<button className="btn btn-primary" type="submit">{authMode === "signin" ? "Se connecter" : "Créer mon espace"}</button></div>
          </form>
          <div className="switch-link">{authMode === "signin" ? "Nouveau ici ?" : "Déjà un compte ?"} <button onClick={() => setAuthMode(authMode === "signin" ? "signup" : "signin")}>{authMode === "signin" ? "Créer un compte" : "Se connecter"}</button></div>
        </Modal>
      )}

      {modal === "transaction" && (
        <Modal title={editingTransaction ? "Modifier l’opération" : transactionType === "expense" ? "Dépense rapide" : "Ajouter un revenu"} onClose={() => { setEditingTransactionId(null); setModal(null); }}>
          <form onSubmit={addTransaction}>
            <div className="expense-form">
              <div className="segmented expense-type">
                <button type="button" className={transactionType === "expense" ? "active" : ""} onClick={() => chooseOperationType("expense")}>Dépense</button>
                <button type="button" className={transactionType === "income" ? "active" : ""} onClick={() => chooseOperationType("income")}>Revenu</button>
              </div>
              <label className="label amount-label">
                Montant
                <span className="amount-wrap"><input className="field amount-input" name="amount" inputMode="decimal" placeholder="0,00" defaultValue={editingTransaction?.amount} autoFocus required /><b>€</b></span>
              </label>
              <label className="label">
                Motif {transactionType === "expense" ? "de la dépense" : "du revenu"}
                <select className="field" name="reason" value={selectedReason} onChange={(event) => chooseReason(event.target.value)}>
                  {availableReasons(transactionType).map((reason) => <option key={reason.label}>{reason.label}</option>)}
                </select>
              </label>
              {editingTransaction && (editingTransaction.originalLabel || editingTransaction.label) !== selectedReason && <div className="original-label-card"><span>Libellé bancaire d’origine</span><strong>{editingTransaction.originalLabel || editingTransaction.label}</strong></div>}
              {selectedReason.startsWith("Autre") && <label className="label">Précision<input className="field" name="customReason" value={customReason} onChange={(event) => setCustomReason(event.target.value)} placeholder="Ex. Cadeau, remboursement…" required /></label>}
              {needsPersonDetail(selectedReason) && <label className="label">Personne concernée<input className="field" name="person" value={operationPerson} onChange={(event) => setOperationPerson(event.target.value)} placeholder="Marion ou Philippe" required /></label>}
              <div className="category-auto"><span>{categoryIcons[selectedCategory] || "•"}</span> Catégorie automatique : <strong>{selectedCategory}</strong></div>
              <div className="form-grid expense-details">
                <label className="label">Compte<select className="field" name="accountId" defaultValue={editingTransaction?.accountId}>{visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                <label className="label">Date<input className="field" type="date" name="date" defaultValue={editingTransaction?.date || new Date().toISOString().slice(0, 10)} required /></label>
              </div>
            </div>
            <div className="form-actions expense-submit"><button type="button" className="btn btn-soft" onClick={() => { setEditingTransactionId(null); setModal(null); }}>Annuler</button><button className="btn btn-primary" disabled={isSaving}>{isSaving ? "Enregistrement…" : editingTransaction ? "Enregistrer les modifications" : transactionType === "expense" ? "Enregistrer la dépense" : "Enregistrer le revenu"}</button></div>
          </form>
        </Modal>
      )}

      {modal === "account" && (
        <Modal title={editingAccount ? "Modifier le compte et son solde" : "Ajouter un compte"} onClose={() => { setEditingAccountId(null); setModal(null); }}>
          <form onSubmit={addAccount}>
            <div className="form-grid">
              <label className="label wide">Nom du compte<input className="field" name="name" placeholder="Ex. Compte joint" defaultValue={editingAccount?.name} required /></label>
              <label className="label">Type<select className="field" name="type" value={accountTypeDraft} onChange={(event) => setAccountTypeDraft(event.target.value)}><option>Courant</option><option>Épargne</option><option>Carte</option><option>Espèces</option></select></label>
              {accountTypeDraft === "Carte" && <label className="label wide">Compte débité à la fin du mois<select className="field" name="debitAccountId" defaultValue={editingAccount?.debitAccountId || ""}><option value="">Sélectionner le compte débité</option>{visibleAccounts.filter((account) => account.id !== editingAccount?.id).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select><small className="field-help">Les achats restent sur la carte jusqu’à la date de débit.</small></label>}
              <label className="label">Solde actuel<input className="field" name="balance" inputMode="decimal" defaultValue={editingAccount?.balance ?? 0} /></label>
              <label className="label">Date du solde<input className="field" type="date" name="balanceDate" defaultValue={new Date().toISOString().slice(0, 10)} /></label>
              <label className="label wide">Visibilité<select className="field" name="visibility" defaultValue={editingAccount?.visibility || "shared"}><option value="shared">Partagé avec le foyer</option><option value="private">Personnel — moi uniquement</option></select></label>
            </div>
            <div className="form-actions"><button className="btn btn-primary" disabled={isSaving}>{isSaving ? "Enregistrement…" : editingAccount ? "Enregistrer le compte" : "Créer le compte"}</button></div>
          </form>
        </Modal>
      )}

      {modal === "goal" && (
        <Modal title={editingGoal ? "Modifier le projet" : "Planifier un projet"} onClose={() => { setEditingGoalId(null); setModal(null); }}>
          <form onSubmit={addGoal}>
            <div className="form-grid">
              <label className="label wide">Nom du projet<input className="field" name="name" placeholder="Ex. Vacances d’été" defaultValue={editingGoal?.name} required /></label>
              <label className="label">Budget total<input className="field" name="target" inputMode="decimal" defaultValue={editingGoal?.target} required /></label>
              <label className="label">Déjà épargné<input className="field" name="saved" inputMode="decimal" defaultValue={editingGoal?.saved ?? 0} /></label>
              <label className="label wide">Date prévue<input className="field" type="date" name="dueDate" defaultValue={editingGoal?.dueDate} required /></label>
            </div>
            <div className="form-actions"><button className="btn btn-primary" disabled={isSaving}>{isSaving ? "Enregistrement…" : editingGoal ? "Enregistrer le projet" : "Créer et calculer la mensualité"}</button></div>
          </form>
        </Modal>
      )}

      {modal === "recurring" && (
        <Modal title={editingRecurringId ? "Modifier la charge récurrente" : "Programmer une charge mensuelle"} onClose={() => { setEditingRecurringId(null); setModal(null); }}>
          {(() => {
            const editing = editingRecurringId ? recurringExpenses.find((item) => item.id === editingRecurringId) : undefined;
            return <form onSubmit={addRecurringExpense}>
              <div className="form-grid">
                <label className="label wide">Libellé<input className="field" name="label" placeholder="Ex. Loyer, assurance, téléphone" defaultValue={editing?.label} required /></label>
                <label className="label">Montant<input className="field" name="amount" inputMode="decimal" defaultValue={editing?.amount} placeholder="0,00" required /></label>
                <label className="label">Jour du mois<input className="field" name="day" type="number" min="1" max="28" defaultValue={editing?.day || 5} required /></label>
                <label className="label">Catégorie<select className="field" name="category" defaultValue={editing?.category || "Charges"}>{["Logement", "Charges", "Transport", "Abonnements", "Autre"].map((category) => <option key={category}>{category}</option>)}</select></label>
                <label className="label">Compte<select className="field" name="accountId" defaultValue={editing?.accountId || visibleAccounts[0]?.id}>{visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                <label className="label wide">À partir du<input className="field" name="startDate" type="date" defaultValue={editing?.startDate || new Date().toISOString().slice(0, 10)} required /></label>
              </div>
              <div className="form-actions"><button type="button" className="btn btn-soft" onClick={() => { setEditingRecurringId(null); setModal(null); }}>Annuler</button><button className="btn btn-primary" disabled={isSaving}>{isSaving ? "Enregistrement…" : editing ? "Enregistrer" : "Programmer la charge"}</button></div>
            </form>;
          })()}
        </Modal>
      )}

      {modal === "budget" && (
        <Modal title="Budget mensuel" onClose={() => setModal(null)}>
          <form onSubmit={saveMonthlyBudget}>
            <div className="auth-intro">Ce montant sert de référence pour calculer le pourcentage de budget utilisé et le reste disponible.</div>
            <label className="label amount-label">Budget maximum du mois<span className="amount-wrap"><input className="field amount-input" name="monthlyBudget" inputMode="decimal" defaultValue={monthlyBudget} autoFocus required /><b>€</b></span></label>
            <div className="form-actions"><button className="btn btn-primary">Enregistrer le budget</button></div>
          </form>
        </Modal>
      )}

      {modal === "budgetPlan" && (
        <Modal title={editingBudgetPlanId ? "Modifier le budget prévisionnel" : "Ajouter un budget prévisionnel"} onClose={() => { setEditingBudgetPlanId(null); setModal(null); }}>
          <form onSubmit={saveBudgetPlan}>
            <div className="auth-intro">Exemple : Concert / spectacle à 60 € par mois. Après 30 € dépensés, il restera 30 € et 50 % du budget.</div>
            <div className="form-grid">
              <label className="label">Type<select className="field" name="type" defaultValue={editingBudgetPlanId ? budgetPlans.find((item) => item.id === editingBudgetPlanId)?.type || "expense" : "expense"}><option value="income">Revenu prévisionnel</option><option value="expense">Dépense prévisionnelle</option></select></label>
              <label className="label">Périodicité<select className="field" name="scope" value={budgetPlanScopeDraft} onChange={(event) => { const scope = event.target.value as BudgetPlanScope; setBudgetPlanScopeDraft(scope); setBudgetPlanPeriodDraft(scope === "monthly" ? selectedPeriod : selectedPeriod.slice(0, 4)); }}><option value="monthly">Chaque mois</option><option value="annual">Pour l’année</option></select></label>
              <label className="label">{budgetPlanScopeDraft === "monthly" ? "Mois" : "Année"}<input className="field" name="period" type={budgetPlanScopeDraft === "monthly" ? "month" : "number"} min={budgetPlanScopeDraft === "annual" ? "2020" : undefined} max={budgetPlanScopeDraft === "annual" ? "2100" : undefined} value={budgetPlanPeriodDraft} onChange={(event) => setBudgetPlanPeriodDraft(event.target.value)} required /></label>
              <label className="label wide">Motif concerné<select className="field" name="reason" defaultValue={editingBudgetPlanId ? budgetPlans.find((item) => item.id === editingBudgetPlanId)?.reason : "Concert / spectacle"}>{[...new Map([...budgetReasonOptions, ...operationReasons.income].map((reason) => [reason.label, reason])).values()].map((reason) => <option key={reason.label} value={reason.label}>{categoryIcons[reason.category] || "📌"} {reason.label}</option>)}</select></label>
              <label className="label amount-label wide">Montant prévu<span className="amount-wrap"><input className="field amount-input" name="amount" inputMode="decimal" defaultValue={editingBudgetPlanId ? budgetPlans.find((item) => item.id === editingBudgetPlanId)?.amount : ""} placeholder="60,00" required /><b>€</b></span></label>
            </div>
            <div className="form-actions">{editingBudgetPlanId && <button type="button" className="btn btn-danger" onClick={() => { const plan = budgetPlans.find((item) => item.id === editingBudgetPlanId); if (plan) void deleteBudgetPlan(plan).then((deleted) => { if (deleted) { setEditingBudgetPlanId(null); setModal(null); } }); }}>Supprimer</button>}<button type="button" className="btn btn-soft" onClick={() => { setEditingBudgetPlanId(null); setModal(null); }}>Annuler</button><button className="btn btn-primary" disabled={isSaving}>{isSaving ? "Enregistrement…" : editingBudgetPlanId ? "Enregistrer les modifications" : "Ajouter le budget"}</button></div>
          </form>
        </Modal>
      )}

      {modal === "reset" && (
        <Modal title="Remettre les données à zéro" onClose={() => setModal(null)}>
          <div className="reset-warning"><strong>Cette action est irréversible.</strong><p>Les opérations et projets seront supprimés. Les soldes des comptes et le budget mensuel seront remis à 0 €.</p></div>
          <div className="form-actions"><button className="btn btn-soft" onClick={() => setModal(null)}>Annuler</button><button className="btn btn-danger" onClick={resetData} disabled={isSaving}>{isSaving ? "Remise à zéro…" : "Confirmer la remise à zéro"}</button></div>
        </Modal>
      )}

      {modal === "csv" && (
        <Modal title="Importer un relevé bancaire" onClose={closeCsvImport}>
          <div className="import-settings">
            <label className="label">
              Compte concerné par le relevé
              <select className="field" value={csvAccountId} onChange={(event) => {
                setCsvAccountId(event.target.value);
                setCsvCustomBalance("");
                const account = visibleAccounts.find((item) => item.id === event.target.value);
                setCsvBalanceMode(account?.type === "Carte" ? "keep" : "calculate");
              }} required>
                <option value="">Sélectionner un compte</option>
                {visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} — {money.format(Number(account.balance || 0))}</option>)}
              </select>
            </label>
          </div>
          {selectedCsvAccount?.type === "Carte" && <div className="import-balance-card card-import-note"><strong>💳 Carte à débit différé</strong><p className="muted">Les opérations seront rattachées à la carte. Le compte débité ne sera pas modifié avant la date indiquée.</p>{selectedCsvDebitAccount ? <p className="deferred-link-note">Compte débité : <strong>{selectedCsvDebitAccount.name}</strong></p> : <p className="deferred-link-warning">Associez un compte débité dans « Comptes » pour suivre automatiquement l’encours.</p>}<label className="label">Date de débit prévue<input className="field" type="date" value={csvDebitDate} onChange={(event) => setCsvDebitDate(event.target.value)} required /></label></div>}
          <div
            className={`drop-zone ${csvError ? "drop-zone-error" : csvFileName ? "drop-zone-ready" : ""}`}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void loadCsvFile(event.dataTransfer.files?.[0]);
            }}
          >
            <strong>Déposez votre export bancaire CSV</strong>
            <p className="muted">Glissez le fichier ici ou choisissez-le. Les exports avec préambule, séparateur « ; » ou « , » et encodage bancaire Windows sont acceptés.</p>
            <input type="file" accept=".csv,text/csv" onChange={(event) => void loadCsvFile(event.target.files?.[0])} />
            {csvFileName && <div className="csv-file-name">Fichier sélectionné : <strong>{csvFileName}</strong></div>}
          </div>
          {csvError && <div className="csv-error" role="alert"><strong>Import impossible</strong><span>{csvError}</span><small>Colonnes attendues : Date, Libellé et Montant — ou Débit / Crédit.</small></div>}
          {csvPreview.length > 0 && (
            <>
              {csvDuplicateCandidates.length > 0 && <div className="csv-duplicate-review" role="region" aria-label="Contrôle des doublons"><strong>{csvDuplicateCandidates.length} doublon(s) possible(s)</strong><p>Ces opérations ressemblent à des dépenses déjà saisies manuellement. Cochez uniquement celles que vous souhaitez importer malgré tout.</p>{csvDuplicateCandidates.map((candidate) => <label className="duplicate-row" key={candidate.row.id}><input type="checkbox" checked={Boolean(csvDuplicateDecisions[candidate.row.id])} onChange={(event) => setCsvDuplicateDecisions((current) => ({ ...current, [candidate.row.id]: event.target.checked }))} /><span><b>{candidate.row.label}</b><small>{candidate.row.date} · {money.format(candidate.row.amount)} · déjà saisie : {candidate.existing.label} ({candidate.daysApart === 0 ? "même date" : `${candidate.daysApart} jour(s) d’écart`})</small></span></label>)}</div>}
              <div className="import-preview">
                <strong>{csvRowsToImport.length} nouvelle(s) opération(s) à importer{csvDuplicateCandidates.length ? ` sur ${csvPreview.length} détectée(s)` : " détectée(s)"}</strong>
                <div className="import-summary-grid">
                  <span>Dépenses <b>{money.format(csvExpenses)}</b></span>
                  <span>Revenus <b>{money.format(csvIncome)}</b></span>
                  <span>Impact total <b>{csvImpact >= 0 ? "+" : "−"} {money.format(Math.abs(csvImpact))}</b></span>
                </div>
              </div>
              <div className="import-balance-card">
                <label className="label">
                  Solde après l’import
                  <select className="field" value={csvBalanceMode} onChange={(event) => setCsvBalanceMode(event.target.value as CsvBalanceMode)}>
                    <option value="calculate">Recalculer automatiquement avec les opérations</option>
                    <option value="keep">Conserver le solde actuel</option>
                    <option value="custom">Définir le solde manuellement</option>
                  </select>
                </label>
                {csvBalanceMode === "calculate" && selectedCsvAccount && (
                  <p>Solde estimé de <strong>{selectedCsvAccount.name}</strong> : <b>{money.format(csvProjectedBalance)}</b></p>
                )}
                {csvBalanceMode === "keep" && selectedCsvAccount && (
                  <p>Le solde restera à <b>{money.format(Number(selectedCsvAccount.balance || 0))}</b>.</p>
                )}
                {csvBalanceMode === "custom" && (
                  <label className="label">Nouveau solde du compte<input className="field" value={csvCustomBalance} onChange={(event) => setCsvCustomBalance(event.target.value)} inputMode="decimal" placeholder="0,00" required /></label>
                )}
              </div>
            </>
          )}
          <div className="form-actions"><button className="btn btn-soft" onClick={closeCsvImport}>Annuler</button><button className="btn btn-primary" disabled={!csvPreview.length || !csvAccountId || !csvCustomBalanceIsValid || isSaving} onClick={importCsv}>{isSaving ? "Import en cours…" : "Importer les opérations"}</button></div>
        </Modal>
      )}

      {!firebaseReady && <div className="toast">Configuration Firebase manquante. Consultez le fichier .env.example.</div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function SummaryCard({ label, value, note, accent, onClick }: { label: string; value: number; note: string; accent: string; onClick: () => void }) {
  return (
    <article className="card summary-card summary-card-clickable" style={{ "--accent": accent } as CSSProperties} onClick={onClick} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onClick(); }}>
      <div className="summary-label"><span className="summary-dot" />{label}</div>
      <div className="summary-value">{money.format(value)}</div>
      <div className="trend">{note}</div>
    </article>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><div><h2>{title}</h2><div className="muted">Simple, clair et modifiable à tout moment.</div></div><button className="close" aria-label="Fermer" onClick={onClose}>×</button></div>
        {children}
      </section>
    </div>
  );
}
