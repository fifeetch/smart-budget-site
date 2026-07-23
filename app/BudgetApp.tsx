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
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { auth, db, firebaseReady } from "@/lib/firebase";

type ModalName = "auth" | "transaction" | "account" | "csv" | "goal" | null;
type TransactionType = "expense" | "income";

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
  Transport: "↗",
  Loisirs: "✦",
  Santé: "+",
  Abonnements: "◉",
  Salaire: "↓",
  Autre: "•",
};

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
  const [csvPreview, setCsvPreview] = useState<ReturnType<typeof parseCsv>>([]);
  const [transactionType, setTransactionType] = useState<TransactionType>("expense");
  const [selectedCategory, setSelectedCategory] = useState("Alimentation");
  const [expenseLabel, setExpenseLabel] = useState("");

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (!currentUser || !db) {
        setHouseholdId(null);
        setAccounts(demoAccounts);
        setTransactions(demoTransactions);
        setGoals(demoGoals);
        return;
      }

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
          createdAt: Timestamp.now(),
        });
        batch.set(userRef, {
          email: currentUser.email,
          displayName: currentUser.displayName || "",
          householdId: nextHouseholdId,
          createdAt: Timestamp.now(),
        });
        batch.set(doc(db, "households", nextHouseholdId, "accounts", "principal"), {
          name: "Compte principal",
          type: "Courant",
          balance: 0,
          visibility: "shared",
          ownerId: currentUser.uid,
          createdAt: Timestamp.now(),
        });
        await batch.commit();
      }

      setHouseholdId(nextHouseholdId);
    });
  }, []);

  useEffect(() => {
    if (!db || !householdId) return;
    const base = `households/${householdId}`;
    const cleanups = [
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
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleAccounts = useMemo(
    () => accounts.filter((account) => account.visibility === "shared" || !user || account.ownerId === user.uid),
    [accounts, user],
  );
  const visibleIds = useMemo(() => new Set(visibleAccounts.map((account) => account.id)), [visibleAccounts]);
  const visibleTransactions = useMemo(
    () => transactions.filter((transaction) => visibleIds.has(transaction.accountId)),
    [transactions, visibleIds],
  );
  const income = visibleTransactions.filter((item) => item.type === "income").reduce((sum, item) => sum + item.amount, 0);
  const expenses = visibleTransactions.filter((item) => item.type === "expense").reduce((sum, item) => sum + item.amount, 0);
  const balance = visibleAccounts.reduce((sum, account) => sum + Number(account.balance || 0), 0);

  const requireUser = (next: Exclude<ModalName, "auth" | null>) => {
    if (!user) {
      setAuthMode("signin");
      setModal("auth");
      setToast("Connectez-vous pour enregistrer vos données.");
      return;
    }
    setModal(next);
  };

  const openQuickExpense = (category = "Alimentation", label = "") => {
    setTransactionType("expense");
    setSelectedCategory(category);
    setExpenseLabel(label);
    requireUser("transaction");
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (!isTyping && !modal && event.key.toLowerCase() === "e") {
        event.preventDefault();
        setTransactionType("expense");
        setSelectedCategory("Alimentation");
        setExpenseLabel("");
        if (user) {
          setModal("transaction");
        } else {
          setAuthMode("signin");
          setModal("auth");
          setToast("Connectez-vous pour enregistrer vos dépenses.");
        }
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
    if (!db || !householdId || !user) return;
    const data = new FormData(event.currentTarget);
    const amount = Number(String(data.get("amount")).replace(",", "."));
    const transaction = {
      label: String(data.get("label")),
      amount,
      type: transactionType,
      category: selectedCategory,
      accountId: String(data.get("accountId")),
      date: String(data.get("date")),
      createdBy: user.uid,
      createdAt: Timestamp.now(),
    };
    await addDoc(collection(db, "households", householdId, "transactions"), transaction);
    const account = accounts.find((item) => item.id === transaction.accountId);
    if (account) {
      await setDoc(
        doc(db, "households", householdId, "accounts", account.id),
        { balance: Number(account.balance || 0) + (transaction.type === "income" ? amount : -amount) },
        { merge: true },
      );
    }
    setModal(null);
    setExpenseLabel("");
    setToast("Mouvement ajouté au budget.");
  };

  const addAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!db || !householdId || !user) return;
    const data = new FormData(event.currentTarget);
    await addDoc(collection(db, "households", householdId, "accounts"), {
      name: String(data.get("name")),
      type: String(data.get("type")),
      balance: Number(String(data.get("balance")).replace(",", ".")) || 0,
      visibility: String(data.get("visibility")),
      ownerId: user.uid,
      createdAt: Timestamp.now(),
    });
    setModal(null);
    setToast("Nouveau compte ajouté.");
  };

  const addGoal = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!db || !householdId) return;
    const data = new FormData(event.currentTarget);
    const target = Number(String(data.get("target")).replace(",", "."));
    const saved = Number(String(data.get("saved")).replace(",", ".")) || 0;
    const dueDate = String(data.get("dueDate"));
    const months = Math.max(1, Math.ceil((new Date(dueDate).getTime() - Date.now()) / (30.44 * 86400000)));
    await addDoc(collection(db, "households", householdId, "goals"), {
      name: String(data.get("name")),
      target,
      saved,
      dueDate,
      monthly: Math.max(0, (target - saved) / months),
      createdAt: Timestamp.now(),
    });
    setModal(null);
    setToast("Projet ajouté avec sa mensualité conseillée.");
  };

  const importCsv = async () => {
    if (!db || !householdId || !user || !csvPreview.length) return;
    const accountId = visibleAccounts[0]?.id;
    if (!accountId) return;
    const batch = writeBatch(db);
    csvPreview.forEach((row) => {
      const reference = doc(collection(db, "households", householdId, "transactions"));
      batch.set(reference, { ...row, accountId, createdBy: user.uid, imported: true, createdAt: Timestamp.now() });
    });
    await batch.commit();
    setCsvPreview([]);
    setModal(null);
    setToast(`${csvPreview.length} opérations importées.`);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">S</span><span>Smart Budget</span></div>
        <div className="household-pill"><small>Espace du foyer</small><strong>{user ? "Mon foyer" : "Foyer Démo"}</strong></div>
        <nav className="nav" aria-label="Navigation principale">
          {[
            ["▦", "Vue d’ensemble"],
            ["↕", "Transactions"],
            ["▣", "Comptes"],
            ["◎", "Projets"],
            ["♙", "Mon foyer"],
          ].map(([icon, label]) => (
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
            <h1>Bonjour {user?.displayName?.split(" ")[0] || "à vous"}.</h1>
          </div>
          <div className="top-actions">
            <select className="period-select" aria-label="Période"><option>Juillet 2026</option></select>
            {user ? (
              <button className="btn btn-soft" onClick={() => auth && signOut(auth)}>Déconnexion</button>
            ) : (
              <button className="btn btn-soft" onClick={() => setModal("auth")}>Se connecter</button>
            )}
            <button className="btn btn-primary" onClick={() => openQuickExpense()}>＋ Dépense rapide</button>
          </div>
        </header>

        {!user && (
          <div className="goals-banner card" style={{ marginTop: 0, marginBottom: 18 }}>
            <div><strong>Explorez Smart Budget avec des données d’exemple.</strong><p>Créez votre compte pour connecter votre propre foyer et conserver vos données.</p></div>
            <button className="btn btn-lime" onClick={() => { setAuthMode("signup"); setModal("auth"); }}>Créer mon espace</button>
          </div>
        )}

        <section className="quick-expense card" aria-label="Ajouter rapidement une dépense">
          <div className="quick-expense-copy">
            <span className="quick-expense-icon">＋</span>
            <div><strong>Une dépense à noter ?</strong><span>Ajoutez-la maintenant, cela prend moins de 10 secondes.</span></div>
          </div>
          <div className="quick-presets">
            {[
              ["Alimentation", "Courses", "◒"],
              ["Transport", "Transport", "↗"],
              ["Loisirs", "Sortie", "✦"],
            ].map(([category, label, icon]) => (
              <button key={category} onClick={() => openQuickExpense(category, label)}>
                <span>{icon}</span>{label}
              </button>
            ))}
            <button className="quick-main" onClick={() => openQuickExpense()}>＋ Autre dépense</button>
          </div>
        </section>

        <section className="summary-grid" aria-label="Résumé du budget">
          <SummaryCard label="Solde disponible" value={balance} note="Tous les comptes visibles" accent="var(--green)" />
          <SummaryCard label="Revenus ce mois" value={income} note="↓ Entrées enregistrées" accent="var(--mint)" />
          <SummaryCard label="Dépenses ce mois" value={expenses} note={`${income ? Math.round((expenses / income) * 100) : 0} % de vos revenus`} accent="var(--coral)" />
        </section>

        <section className="dashboard-grid">
          <article className="card panel">
            <div className="panel-head"><h2 className="panel-title">Où part votre argent ?</h2><button className="text-button">Voir le détail →</button></div>
            <div className="chart-wrap">
              <div className="donut" aria-label="Répartition des dépenses par catégorie" />
              <div className="legend">
                {[
                  ["var(--green)", "Logement", 980],
                  ["var(--coral)", "Alimentation", 412],
                  ["var(--yellow)", "Transport", 286],
                  ["var(--mint)", "Loisirs & autres", 203],
                ].map(([color, label, value]) => (
                  <div className="legend-row" key={String(label)}><span className="legend-color" style={{ background: String(color) }} /><span>{label}</span><strong>{money.format(Number(value))}</strong></div>
                ))}
              </div>
            </div>
          </article>

          <article className="card panel">
            <div className="panel-head"><h2 className="panel-title">Mes comptes</h2><button className="text-button" onClick={() => requireUser("account")}>＋ Ajouter</button></div>
            <div className="account-list">
              {visibleAccounts.slice(0, 4).map((account) => (
                <div className="account-row" key={account.id}>
                  <span className="account-icon">{account.type === "Épargne" ? "◇" : "▰"}</span>
                  <div><div className="account-name">{account.name}</div><div className="account-meta">{account.type}</div>{account.visibility === "private" && <span className="privacy-pill">● privé</span>}</div>
                  <div className="account-amount">{money.format(Number(account.balance || 0))}</div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="card transactions">
          <div className="panel-head">
            <h2 className="panel-title">Derniers mouvements</h2>
            <div><button className="text-button" onClick={() => requireUser("csv")}>Importer un CSV</button><button className="text-button">Tout voir →</button></div>
          </div>
          <div className="transaction-list">
            {visibleTransactions.length ? visibleTransactions.slice(0, 7).map((transaction) => (
              <div className="transaction-row" key={transaction.id}>
                <span className="transaction-icon">{categoryIcons[transaction.category] || "•"}</span>
                <div><div className="transaction-label">{transaction.label}</div><div className="muted">{visibleAccounts.find((account) => account.id === transaction.accountId)?.name || "Compte"}</div></div>
                <div className="transaction-category">{transaction.category}</div>
                <div className="transaction-date">{displayDate.format(new Date(transaction.date))}</div>
                <div className={`transaction-amount ${transaction.type}`}>{transaction.type === "income" ? "+" : "−"} {money.format(transaction.amount)}</div>
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
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{goal.name}</strong><span>{money.format(goal.saved)} / {money.format(goal.target)}</span></div>
                  <div className="progress"><span style={{ width: `${Math.min(100, (goal.saved / goal.target) * 100)}%` }} /></div>
                  <div className="muted">{money.format(goal.monthly)} / mois conseillé</div>
                </div>
              ))}
            </div>
          </div>
          <button className="btn btn-lime" onClick={() => requireUser("goal")}>＋ Nouveau projet</button>
        </section>
      </main>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {["▦", "↕", "＋", "◎", "♙"].map((icon, index) => <button key={`${icon}-${index}`} aria-label={index === 2 ? "Ajouter une dépense" : undefined} className={index === 0 ? "active" : index === 2 ? "add-mobile" : ""} onClick={() => index === 2 && openQuickExpense()}>{icon}</button>)}
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
        <Modal title={transactionType === "expense" ? "Dépense rapide" : "Ajouter un revenu"} onClose={() => setModal(null)}>
          <form onSubmit={addTransaction}>
            <div className="expense-form">
              <div className="segmented expense-type">
                <button type="button" className={transactionType === "expense" ? "active" : ""} onClick={() => { setTransactionType("expense"); setSelectedCategory("Alimentation"); }}>Dépense</button>
                <button type="button" className={transactionType === "income" ? "active" : ""} onClick={() => { setTransactionType("income"); setSelectedCategory("Salaire"); }}>Revenu</button>
              </div>
              <label className="label amount-label">
                Montant
                <span className="amount-wrap"><input className="field amount-input" name="amount" inputMode="decimal" placeholder="0,00" autoFocus required /><b>€</b></span>
              </label>
              <label className="label">
                Pour quoi ?
                <input className="field" name="label" value={expenseLabel} onChange={(event) => setExpenseLabel(event.target.value)} placeholder={transactionType === "expense" ? "Ex. Courses, café, essence…" : "Ex. Salaire, remboursement…"} required />
              </label>
              <fieldset className="category-fieldset">
                <legend>Catégorie</legend>
                <div className="category-chips">
                  {Object.keys(categoryIcons)
                    .filter((name) => transactionType === "income" ? ["Salaire", "Autre"].includes(name) : name !== "Salaire")
                    .map((name) => (
                      <button type="button" key={name} className={selectedCategory === name ? "active" : ""} onClick={() => setSelectedCategory(name)}>
                        <span>{categoryIcons[name]}</span>{name}
                      </button>
                    ))}
                </div>
              </fieldset>
              <div className="form-grid expense-details">
                <label className="label">Compte<select className="field" name="accountId">{visibleAccounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
                <label className="label">Date<input className="field" type="date" name="date" defaultValue={new Date().toISOString().slice(0, 10)} required /></label>
              </div>
            </div>
            <div className="form-actions expense-submit"><button type="button" className="btn btn-soft" onClick={() => setModal(null)}>Annuler</button><button className="btn btn-primary">{transactionType === "expense" ? "Enregistrer la dépense" : "Enregistrer le revenu"}</button></div>
          </form>
        </Modal>
      )}

      {modal === "account" && (
        <Modal title="Ajouter un compte" onClose={() => setModal(null)}>
          <form onSubmit={addAccount}>
            <div className="form-grid">
              <label className="label wide">Nom du compte<input className="field" name="name" placeholder="Ex. Compte joint" required /></label>
              <label className="label">Type<select className="field" name="type"><option>Courant</option><option>Épargne</option><option>Carte</option><option>Espèces</option></select></label>
              <label className="label">Solde actuel<input className="field" name="balance" inputMode="decimal" defaultValue="0" /></label>
              <label className="label wide">Visibilité<select className="field" name="visibility"><option value="shared">Partagé avec le foyer</option><option value="private">Personnel — moi uniquement</option></select></label>
            </div>
            <div className="form-actions"><button className="btn btn-primary">Créer le compte</button></div>
          </form>
        </Modal>
      )}

      {modal === "goal" && (
        <Modal title="Planifier un projet" onClose={() => setModal(null)}>
          <form onSubmit={addGoal}>
            <div className="form-grid">
              <label className="label wide">Nom du projet<input className="field" name="name" placeholder="Ex. Vacances d’été" required /></label>
              <label className="label">Budget total<input className="field" name="target" inputMode="decimal" required /></label>
              <label className="label">Déjà épargné<input className="field" name="saved" inputMode="decimal" defaultValue="0" /></label>
              <label className="label wide">Date prévue<input className="field" type="date" name="dueDate" required /></label>
            </div>
            <div className="form-actions"><button className="btn btn-primary">Calculer ma mensualité</button></div>
          </form>
        </Modal>
      )}

      {modal === "csv" && (
        <Modal title="Importer un relevé bancaire" onClose={() => { setCsvPreview([]); setModal(null); }}>
          <div className="drop-zone">
            <strong>Déposez votre export bancaire CSV</strong>
            <p className="muted">Smart Budget reconnaît les colonnes date, libellé, montant, débit et crédit.</p>
            <input type="file" accept=".csv,text/csv" onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setCsvPreview(parseCsv(await file.text()));
            }} />
          </div>
          {csvPreview.length > 0 && <div className="import-preview"><strong>{csvPreview.length} opérations détectées</strong><br />Dépenses : {money.format(csvPreview.filter((row) => row.type === "expense").reduce((sum, row) => sum + row.amount, 0))}</div>}
          <div className="form-actions"><button className="btn btn-primary" disabled={!csvPreview.length} onClick={importCsv}>Importer les opérations</button></div>
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
