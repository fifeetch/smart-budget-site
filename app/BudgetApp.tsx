"use client";

import type { CSSProperties, FormEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import {
  type User,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  Timestamp,
  collection,
  deleteDoc,
  doc,
  getDoc,
  increment,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { auth, db, firebaseReady } from "@/lib/firebase";

type ModalName = "auth" | "transaction" | "account" | "csv" | "goal" | "budget" | "reset" | null;
type TransactionType = "expense" | "income";
type CsvBalanceMode = "calculate" | "keep" | "custom";

type Account = {
  id: string;
  name: string;
  type: string;
  balance: number;
  visibility: "shared" | "private";
  ownerId: string;
};

type Transaction = {
  id: string;
  label: string;
  amount: number;
  type: TransactionType;
  category: string;
  accountId: string;
  date: string;
  createdBy?: string;
};

type Goal = {
  id: string;
  name: string;
  target: number;
  saved: number;
  dueDate: string;
  monthly: number;
};

const categoryIcons: Record<string, string> = {
  Alimentation: "◒",
  Logement: "⌂",
  Charges: "▤",
  Transport: "↗",
  Loisirs: "✦",
  Santé: "+",
  Abonnements: "◉",
  Salaire: "↓",
  Autre: "•",
};

const operationReasons: Record<TransactionType, { label: string; category: string }[]> = {
  expense: [
    { label: "Courses", category: "Alimentation" },
    { label: "Carburant", category: "Transport" },
    { label: "Facture d’électricité", category: "Charges" },
    { label: "Loyer", category: "Logement" },
    { label: "Restaurant ou sortie", category: "Loisirs" },
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

const chartColors = ["var(--green)", "var(--coral)", "var(--yellow)", "var(--mint)", "#7ca7d8", "#b58ad3", "#89b9a1"];

const navigationItems = [
  ["▦", "Vue d’ensemble"],
  ["↕", "Transactions"],
  ["▣", "Comptes"],
  ["◎", "Projets"],
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

function parseCsv(text: string) {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ";" : ",";
  const split = (line: string) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ""));
  const headers = split(lines[0]).map((header) =>
    header.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
  );
  const find = (...names: string[]) => headers.findIndex((header) => names.some((name) => header.includes(name)));
  const dateIndex = find("date");
  const labelIndex = find("libelle", "description", "operation");
  const amountIndex = find("montant", "amount");
  const debitIndex = find("debit");
  const creditIndex = find("credit");

  return lines
    .slice(1)
    .map((line, index) => {
      const cells = split(line);
      const rawAmount = amountIndex >= 0 ? cells[amountIndex] : "";
      const debit = debitIndex >= 0 ? Number((cells[debitIndex] || "0").replace(/\s/g, "").replace(",", ".")) : 0;
      const credit = creditIndex >= 0 ? Number((cells[creditIndex] || "0").replace(/\s/g, "").replace(",", ".")) : 0;
      const signed = rawAmount ? Number(rawAmount.replace(/\s/g, "").replace(",", ".")) : credit || -Math.abs(debit);
      const rawDate = dateIndex >= 0 ? cells[dateIndex] : "";
      const [day, month, year] = rawDate.split(/[\/.-]/);
      const date = year && year.length === 4
        ? `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
        : rawDate || new Date().toISOString().slice(0, 10);
      return {
        id: `csv-${index}`,
        label: labelIndex >= 0 ? cells[labelIndex] || "Opération importée" : "Opération importée",
        amount: Math.abs(signed || 0),
        type: signed >= 0 ? ("income" as const) : ("expense" as const),
        category: "Autre",
        date,
      };
    })
    .filter((row) => row.amount > 0);
}

export default function BudgetApp() {
  const [user, setUser] = useState<User | null>(null);
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>(demoAccounts);
  const [transactions, setTransactions] = useState<Transaction[]>(demoTransactions);
  const [goals, setGoals] = useState<Goal[]>(demoGoals);
  const [modal, setModal] = useState<ModalName>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authError, setAuthError] = useState("");
  const [toast, setToast] = useState("");
  const [activeNav, setActiveNav] = useState("Vue d’ensemble");
  const [selectedPeriod, setSelectedPeriod] = useState("2026-07");
  const [csvPreview, setCsvPreview] = useState<ReturnType<typeof parseCsv>>([]);
  const [csvAccountId, setCsvAccountId] = useState("");
  const [csvBalanceMode, setCsvBalanceMode] = useState<CsvBalanceMode>("calculate");
  const [csvCustomBalance, setCsvCustomBalance] = useState("");
  const [transactionType, setTransactionType] = useState<TransactionType>("expense");
  const [selectedCategory, setSelectedCategory] = useState("Alimentation");
  const [selectedReason, setSelectedReason] = useState("Courses");
  const [customReason, setCustomReason] = useState("");
  const [editingTransactionId, setEditingTransactionId] = useState<string | null>(null);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [monthlyBudget, setMonthlyBudget] = useState(2000);
  const [authResolved, setAuthResolved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!auth) {
      setAuthResolved(true);
      return;
    }
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (!currentUser || !db) {
        setHouseholdId(null);
        const savedDemo = window.localStorage.getItem("smart-budget-demo");
        if (savedDemo) {
          try {
            const parsed = JSON.parse(savedDemo) as { accounts?: Account[]; transactions?: Transaction[]; goals?: Goal[]; monthlyBudget?: number };
            setAccounts(parsed.accounts || demoAccounts);
            setTransactions(parsed.transactions || demoTransactions);
            setGoals(parsed.goals || demoGoals);
            setMonthlyBudget(parsed.monthlyBudget || 2000);
          } catch {
            setAccounts(demoAccounts);
            setTransactions(demoTransactions);
            setGoals(demoGoals);
          }
        } else {
          setAccounts(demoAccounts);
          setTransactions(demoTransactions);
          setGoals(demoGoals);
        }
        setAuthResolved(true);
        return;
      }

      try {
        const userRef = doc(db, "users", currentUser.uid);
        const userSnap = await getDoc(userRef);
        let nextHouseholdId = userSnap.data()?.householdId as string | undefined;

        if (!nextHouseholdId) {
          nextHouseholdId = currentUser.uid;
          const batch = writeBatch(db);
          batch.set(doc(db, "households", nextHouseholdId), {
            name: `Foyer de ${currentUser.displayName || currentUser.email?.split("@")[0] || "Smart Budget"}`,
            memberIds: [currentUser.uid],
            memberEmails: [currentUser.email],
            monthlyBudget: 2000,
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
    if (!db || !householdId) return;
    const base = `households/${householdId}`;
    const cleanups = [
      onSnapshot(doc(db, "households", householdId), (snapshot) => {
        setMonthlyBudget(Number(snapshot.data()?.monthlyBudget || 2000));
      }),
      onSnapshot(collection(db, base, "accounts"), (snapshot) => {
        setAccounts(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Account)));
      }),
      onSnapshot(query(collection(db, base, "transactions"), orderBy("date", "desc")), (snapshot) => {
        setTransactions(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Transaction)));
      }),
      onSnapshot(collection(db, base, "goals"), (snapshot) => {
        setGoals(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Goal)));
      }),
    ];
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [householdId]);

  useEffect(() => {
    if (!authResolved || user) return;
    window.localStorage.setItem("smart-budget-demo", JSON.stringify({ accounts, transactions, goals, monthlyBudget }));
  }, [accounts, authResolved, goals, monthlyBudget, transactions, user]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleAccounts = useMemo(
    () => accounts.filter((account) => account.visibility === "shared" || !user || account.ownerId === user.uid),
    [accounts, user],
  );
  const visibleIds = useMemo(() => new Set(visibleAccounts.map((account) => account.id)), [visibleAccounts]);
  const allVisibleTransactions = useMemo(
    () => transactions.filter((transaction) => visibleIds.has(transaction.accountId)),
    [transactions, visibleIds],
  );
  const visibleTransactions = useMemo(
    () => allVisibleTransactions.filter((transaction) => transaction.date.startsWith(selectedPeriod)),
    [allVisibleTransactions, selectedPeriod],
  );
  const income = visibleTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expenses = visibleTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  const balance = visibleAccounts.reduce((sum, account) => sum + Number(account.balance || 0), 0);
  const budgetUsage = monthlyBudget ? Math.min(100, Math.round((expenses / monthlyBudget) * 100)) : 0;
  const remainingBudget = Math.max(0, monthlyBudget - expenses);
  const selectedCsvAccount = visibleAccounts.find((account) => account.id === csvAccountId);
  const csvIncome = csvPreview.filter((row) => row.type === "income").reduce((sum, row) => sum + row.amount, 0);
  const csvExpenses = csvPreview.filter((row) => row.type === "expense").reduce((sum, row) => sum + row.amount, 0);
  const csvImpact = csvIncome - csvExpenses;
  const csvProjectedBalance = Number(selectedCsvAccount?.balance || 0) + csvImpact;
  const parsedCsvCustomBalance = Number(csvCustomBalance.replace(/\s/g, "").replace(",", "."));
  const csvCustomBalanceIsValid = csvBalanceMode !== "custom"
    || (csvCustomBalance.trim() !== "" && Number.isFinite(parsedCsvCustomBalance));
  const categoryData = useMemo(() => {
    const totals = new Map<string, number>();
    visibleTransactions.filter((item) => item.type === "expense").forEach((item) => {
      totals.set(item.category, (totals.get(item.category) || 0) + item.amount);
    });
    return [...totals.entries()]
      .map(([label, value], index) => ({ label, value, color: chartColors[index % chartColors.length] }))
      .sort((a, b) => b.value - a.value);
  }, [visibleTransactions]);
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

  const openQuickExpense = (category = "Alimentation", label = "") => {
    setEditingTransactionId(null);
    setTransactionType("expense");
    setSelectedCategory(category);
    setSelectedReason(operationReasons.expense.find((reason) => reason.label === label)?.label || operationReasons.expense[0].label);
    setCustomReason("");
    setModal("transaction");
  };

  const openCsvImport = () => {
    setCsvPreview([]);
    setCsvAccountId(visibleAccounts[0]?.id || "");
    setCsvBalanceMode("calculate");
    setCsvCustomBalance("");
    setModal("csv");
  };

  const closeCsvImport = () => {
    setCsvPreview([]);
    setCsvAccountId("");
    setCsvBalanceMode("calculate");
    setCsvCustomBalance("");
    setModal(null);
  };

  const chooseOperationType = (type: TransactionType) => {
    const firstReason = operationReasons[type][0];
    setTransactionType(type);
    setSelectedReason(firstReason.label);
    setSelectedCategory(firstReason.category);
    setCustomReason("");
  };

  const chooseReason = (label: string) => {
    const reason = operationReasons[transactionType].find((item) => item.label === label);
    setSelectedReason(label);
    if (reason) setSelectedCategory(reason.category);
  };

  const openTransactionEditor = (transaction: Transaction) => {
    const reasons = operationReasons[transaction.type];
    const matchingReason = reasons.find((reason) => reason.label === transaction.label);
    const fallback = transaction.type === "expense" ? "Autre dépense" : "Autre revenu";
    setEditingTransactionId(transaction.id);
    setTransactionType(transaction.type);
    setSelectedCategory(transaction.category);
    setSelectedReason(matchingReason?.label || fallback);
    setCustomReason(matchingReason ? "" : transaction.label);
    setModal("transaction");
  };

  const openAccountEditor = (account?: Account) => {
    setEditingAccountId(account?.id || null);
    setModal("account");
  };

  const openGoalEditor = (goal?: Goal) => {
    setEditingGoalId(goal?.id || null);
    setModal("goal");
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
  }, [modal, user]);

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
    const label = reasonLabel.startsWith("Autre") && customLabel ? customLabel : reason?.label || reasonLabel;
    const accountId = String(data.get("accountId"));
    const transaction: Transaction = {
      id: editingTransactionId || `local-${Date.now()}`,
      label,
      amount,
      type: transactionType,
      category: reason?.category || selectedCategory,
      accountId,
      date: String(data.get("date")),
      createdBy: user?.uid || "demo",
    };
    const previous = editingTransactionId ? transactions.find((item) => item.id === editingTransactionId) : undefined;
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
        amount: transaction.amount,
        type: transaction.type,
        category: transaction.category,
        accountId: transaction.accountId,
        date: transaction.date,
        createdBy: previous?.createdBy || user.uid,
        ...(previous ? {} : { createdAt: Timestamp.now() }),
      };
      batch.set(reference, payload, { merge: Boolean(previous) });

      if (previous?.accountId === transaction.accountId) {
        batch.update(doc(db, "households", householdId, "accounts", transaction.accountId), { balance: increment(newImpact - impact(previous)) });
      } else {
        if (previous) {
          batch.update(doc(db, "households", householdId, "accounts", previous.accountId), { balance: increment(-impact(previous)) });
        }
        batch.update(doc(db, "households", householdId, "accounts", transaction.accountId), { balance: increment(newImpact) });
      }
      await batch.commit();
      setModal(null);
      setEditingTransactionId(null);
      setSelectedReason(operationReasons[transactionType][0].label);
      setCustomReason("");
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
      setToast("Opération supprimée.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      batch.delete(doc(db, "households", householdId, "transactions", transaction.id));
      batch.update(doc(db, "households", householdId, "accounts", transaction.accountId), { balance: increment(reversal) });
      await batch.commit();
      setToast("Opération supprimée et solde recalculé.");
    } catch (error) {
      console.error("Suppression impossible", error);
      setToast("Impossible de supprimer cette opération.");
    } finally {
      setIsSaving(false);
    }
  };

  const addAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const existing = editingAccountId ? accounts.find((item) => item.id === editingAccountId) : undefined;
    const account: Account = {
      id: editingAccountId || `local-account-${Date.now()}`,
      name: String(data.get("name")),
      type: String(data.get("type")),
      balance: Number(String(data.get("balance")).replace(",", ".")) || 0,
      visibility: String(data.get("visibility")) as Account["visibility"],
      ownerId: existing?.ownerId || user?.uid || "demo",
    };
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
    const existing = editingGoalId ? goals.find((item) => item.id === editingGoalId) : undefined;
    const goal: Goal = {
      id: editingGoalId || `local-goal-${Date.now()}`,
      name: String(data.get("name")),
      target,
      saved,
      dueDate,
      monthly: Math.max(0, (target - saved) / months),
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

  const resetData = async () => {
    if (!user) {
      setTransactions([]);
      setGoals([]);
      setAccounts(demoAccounts.map((account) => ({ ...account, balance: 0 })));
      setMonthlyBudget(2000);
      setModal(null);
      setToast("Données d’exemple remises à zéro.");
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      allVisibleTransactions.filter((item) => !item.createdBy || item.createdBy === user.uid).forEach((item) => {
        batch.delete(doc(db, "households", householdId, "transactions", item.id));
      });
      goals.forEach((goal) => batch.delete(doc(db, "households", householdId, "goals", goal.id)));
      visibleAccounts.filter((account) => account.ownerId === user.uid).forEach((account) => {
        batch.update(doc(db, "households", householdId, "accounts", account.id), { balance: 0 });
      });
      batch.set(doc(db, "households", householdId), { monthlyBudget: 2000 }, { merge: true });
      await batch.commit();
      setModal(null);
      setToast("Vos opérations, projets et soldes ont été remis à zéro.");
    } catch (error) {
      console.error("Remise à zéro impossible", error);
      setToast("La remise à zéro n’a pas pu être effectuée.");
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
    if (!csvCustomBalanceIsValid) {
      setToast("Indiquez un solde valide après l’import.");
      return;
    }
    const importedCount = csvPreview.length;
    const nextBalance = csvBalanceMode === "calculate"
      ? Number(account.balance || 0) + csvImpact
      : csvBalanceMode === "custom"
        ? parsedCsvCustomBalance
        : null;
    if (!user) {
      const importedAt = Date.now();
      const rows = csvPreview.map((row, index) => ({
        ...row,
        id: `local-csv-${importedAt}-${index}`,
        accountId,
        createdBy: "demo",
      }));
      setTransactions((current) => [...rows, ...current]);
      if (nextBalance !== null) {
        setAccounts((current) => current.map((item) => item.id === accountId ? { ...item, balance: nextBalance } : item));
      }
      closeCsvImport();
      setToast(`${rows.length} opérations importées en mode découverte.`);
      return;
    }
    if (!db || !householdId) return;
    setIsSaving(true);
    try {
      const batch = writeBatch(db);
      csvPreview.forEach((row) => {
        const { id: temporaryId, ...transaction } = row;
        void temporaryId;
        const reference = doc(collection(db, "households", householdId, "transactions"));
        batch.set(reference, { ...transaction, accountId, createdBy: user.uid, imported: true, createdAt: Timestamp.now() });
      });
      if (csvBalanceMode === "calculate") {
        batch.update(doc(db, "households", householdId, "accounts", accountId), { balance: increment(csvImpact) });
      } else if (csvBalanceMode === "custom") {
        batch.update(doc(db, "households", householdId, "accounts", accountId), { balance: parsedCsvCustomBalance });
      }
      await batch.commit();
      closeCsvImport();
      setToast(`${importedCount} opérations importées dans ${account.name}.`);
    } catch (error) {
      console.error("Import CSV impossible", error);
      setToast("Le relevé bancaire n’a pas pu être importé.");
    } finally {
      setIsSaving(false);
    }
  };

  const editingTransaction = editingTransactionId ? transactions.find((item) => item.id === editingTransactionId) : undefined;
  const editingAccount = editingAccountId ? accounts.find((item) => item.id === editingAccountId) : undefined;
  const editingGoal = editingGoalId ? goals.find((item) => item.id === editingGoalId) : undefined;

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
            <p className="eyebrow">Votre budget, ensemble</p>
            <h1>{activeNav === "Vue d’ensemble" ? `Bonjour ${user?.displayName?.split(" ")[0] || "à vous"}.` : activeNav}</h1>
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
            <button className="btn btn-primary" onClick={() => openQuickExpense()}>＋ Dépense rapide</button>
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
                {operationReasons[transactionType].map((reason) => <option key={reason.label}>{reason.label}</option>)}
              </select>
            </label>
            {selectedReason.startsWith("Autre") && <label className="label">Précision<input className="field" name="customReason" value={customReason} onChange={(event) => setCustomReason(event.target.value)} placeholder="Ex. Cadeau, remboursement…" required /></label>}
            <div className="category-auto"><span>{categoryIcons[selectedCategory] || "•"}</span> Catégorie automatique : <strong>{selectedCategory}</strong></div>
            <div className="form-grid expense-details">
              <label className="label">Compte<select className="field" name="accountId">{visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
              <label className="label">Date<input className="field" type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
            </div>
            <button className="btn btn-primary mobile-save-operation" disabled={isSaving}>{isSaving ? "Enregistrement…" : transactionType === "expense" ? "Enregistrer la dépense" : "Enregistrer le revenu"}</button>
          </form>
        </section>

        <section className="quick-expense card" aria-label="Ajouter rapidement une dépense">
          <div className="quick-expense-copy">
            <span className="quick-expense-icon">＋</span>
            <div><strong>Une dépense à noter ?</strong><span>Ajoutez-la maintenant, cela prend moins de 10 secondes.</span></div>
          </div>
          <div className="quick-presets">
            {[
              ["Alimentation", "Courses", "◒"],
              ["Transport", "Carburant", "↗"],
              ["Loisirs", "Restaurant ou sortie", "✦"],
            ].map(([category, label, icon]) => (
              <button key={category} onClick={() => openQuickExpense(category, label)}>
                <span>{icon}</span>{label}
              </button>
            ))}
            <button className="quick-main" onClick={() => openQuickExpense("Autre", "Autre dépense")}>＋ Autre dépense</button>
          </div>
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
          <SummaryCard label="Solde disponible" value={balance} note="Tous les comptes visibles" accent="var(--green)" />
          <SummaryCard label="Revenus ce mois" value={income} note="↓ Entrées enregistrées" accent="var(--mint)" />
          <SummaryCard label="Dépenses ce mois" value={expenses} note={`${budgetUsage} % du budget mensuel`} accent="var(--coral)" />
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
                  <span className="account-icon">{account.type === "Épargne" ? "◇" : "▰"}</span>
                  <div><div className="account-name">{account.name}</div><div className="account-meta">{account.type}</div>{account.visibility === "private" && <span className="privacy-pill">● privé</span>}</div>
                  <div className="account-side"><div className="account-amount">{money.format(Number(account.balance || 0))}</div><button className="mini-action" onClick={() => openAccountEditor(account)}>Compte / solde</button></div>
                </div>
              ))}
            </div>
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
              <div className="transaction-row" key={transaction.id}>
                <span className="transaction-icon">{categoryIcons[transaction.category] || "•"}</span>
                <div><div className="transaction-label">{transaction.label}</div><div className="muted">{visibleAccounts.find((account) => account.id === transaction.accountId)?.name || "Compte"}</div></div>
                <div className="transaction-category">{transaction.category}</div>
                <div className="transaction-date">{displayDate.format(new Date(transaction.date))}</div>
                <div className="transaction-end"><div className={`transaction-amount ${transaction.type}`}>{transaction.type === "income" ? "+" : "−"} {money.format(transaction.amount)}</div><div className="row-actions"><button onClick={() => openTransactionEditor(transaction)}>Modifier</button><button className="danger-link" onClick={() => deleteTransaction(transaction)}>Supprimer</button></div></div>
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
              <div className="view-actions"><button className="btn btn-soft" onClick={openCsvImport}>Importer un CSV</button><button className="btn btn-primary" onClick={() => openQuickExpense()}>＋ Ajouter</button></div>
            </div>
            <div className="transaction-list">
              {visibleTransactions.length ? visibleTransactions.map((transaction) => (
                <div className="transaction-row" key={transaction.id}>
                  <span className="transaction-icon">{categoryIcons[transaction.category] || "•"}</span>
                  <div><div className="transaction-label">{transaction.label}</div><div className="muted">{visibleAccounts.find((account) => account.id === transaction.accountId)?.name || "Compte"}</div></div>
                  <div className="transaction-category">{transaction.category}</div>
                  <div className="transaction-date">{displayDate.format(new Date(transaction.date))}</div>
                  <div className="transaction-end"><div className={`transaction-amount ${transaction.type}`}>{transaction.type === "income" ? "+" : "−"} {money.format(transaction.amount)}</div><div className="row-actions"><button onClick={() => openTransactionEditor(transaction)}>Modifier</button><button className="danger-link" onClick={() => deleteTransaction(transaction)}>Supprimer</button></div></div>
                </div>
              )) : <div className="empty-state">Aucune opération pour cette période.</div>}
            </div>
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
                  <span className="account-icon">{account.type === "Épargne" ? "◇" : "▰"}</span>
                  <div><div className="account-name">{account.name}</div><div className="account-meta">{account.type}</div>{account.visibility === "private" && <span className="privacy-pill">● privé</span>}</div>
                  <div className="account-side"><div className="account-amount">{money.format(Number(account.balance || 0))}</div><button className="mini-action" onClick={() => openAccountEditor(account)}>Compte / solde</button></div>
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
              <div><strong>Partage familial</strong><p className="muted">Chaque membre utilise son propre accès Firebase.</p></div>
              <div><strong>Confidentialité des comptes</strong><p className="muted">Un compte personnel peut rester visible uniquement par son propriétaire.</p></div>
              <div><strong>Budget mensuel</strong><p className="muted">{money.format(monthlyBudget)} · utilisé pour calculer vos pourcentages.</p><button className="mini-action" onClick={() => setModal("budget")}>Modifier le budget</button></div>
              <div className="danger-zone"><strong>Remise à zéro</strong><p className="muted">Efface les opérations et projets, puis remet les soldes à zéro.</p><button className="btn btn-danger" onClick={() => setModal("reset")}>Remettre mes données à zéro</button></div>
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
          ["◎", "Projets"],
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
              <label className="label wide">Adresse e-mail<input className="field" type="email" name="email" required autoComplete="email" /></label>
              <label className="label wide">Mot de passe<input className="field" type="password" name="password" minLength={6} required autoComplete={authMode === "signin" ? "current-password" : "new-password"} /></label>
            </div>
            {authError && <p style={{ color: "#b54432", fontSize: 13 }}>{authError}</p>}
            <div className="form-actions"><button className="btn btn-primary" type="submit">{authMode === "signin" ? "Se connecter" : "Créer mon espace"}</button></div>
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
                  {operationReasons[transactionType].map((reason) => <option key={reason.label}>{reason.label}</option>)}
                </select>
              </label>
              {selectedReason.startsWith("Autre") && <label className="label">Précision<input className="field" name="customReason" value={customReason} onChange={(event) => setCustomReason(event.target.value)} placeholder="Ex. Cadeau, remboursement…" required /></label>}
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
              <label className="label">Type<select className="field" name="type" defaultValue={editingAccount?.type || "Courant"}><option>Courant</option><option>Épargne</option><option>Carte</option><option>Espèces</option></select></label>
              <label className="label">Solde actuel<input className="field" name="balance" inputMode="decimal" defaultValue={editingAccount?.balance ?? 0} /></label>
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

      {modal === "budget" && (
        <Modal title="Budget mensuel" onClose={() => setModal(null)}>
          <form onSubmit={saveMonthlyBudget}>
            <div className="auth-intro">Ce montant sert de référence pour calculer le pourcentage de budget utilisé et le reste disponible.</div>
            <label className="label amount-label">Budget maximum du mois<span className="amount-wrap"><input className="field amount-input" name="monthlyBudget" inputMode="decimal" defaultValue={monthlyBudget} autoFocus required /><b>€</b></span></label>
            <div className="form-actions"><button className="btn btn-primary">Enregistrer le budget</button></div>
          </form>
        </Modal>
      )}

      {modal === "reset" && (
        <Modal title="Remettre les données à zéro" onClose={() => setModal(null)}>
          <div className="reset-warning"><strong>Cette action est irréversible.</strong><p>Les opérations et projets seront supprimés. Les soldes des comptes seront remis à 0 € et le budget mensuel à 2 000 €.</p></div>
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
              }} required>
                <option value="">Sélectionner un compte</option>
                {visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} — {money.format(Number(account.balance || 0))}</option>)}
              </select>
            </label>
          </div>
          <div className="drop-zone">
            <strong>Déposez votre export bancaire CSV</strong>
            <p className="muted">Smart Budget reconnaît les colonnes date, libellé, montant, débit et crédit.</p>
            <input type="file" accept=".csv,text/csv" onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setCsvPreview(parseCsv(await file.text()));
            }} />
          </div>
          {csvPreview.length > 0 && (
            <>
              <div className="import-preview">
                <strong>{csvPreview.length} opérations détectées</strong>
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

function SummaryCard({ label, value, note, accent }: { label: string; value: number; note: string; accent: string }) {
  return (
    <article className="card summary-card" style={{ "--accent": accent } as CSSProperties}>
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
