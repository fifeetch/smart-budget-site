# Smart Budget

Application de gestion de budget pour une personne seule, un couple, une famille
ou une colocation.

## Fonctionnalités disponibles

- authentification Firebase par e-mail et mot de passe ;
- foyer et données synchronisées avec Cloud Firestore ;
- comptes partagés ou personnels ;
- ajout de dépenses et de revenus par catégorie ;
- import de relevés bancaires CSV ;
- projets futurs avec calcul de mensualité ;
- interface responsive pour ordinateur et mobile.

## Démarrage local

1. Dupliquez `.env.example` en `.env.local`.
2. Complétez les variables avec la configuration de l’application Web Firebase.
3. Installez les dépendances avec `npm install`.
4. Lancez l’application avec `npm run dev`.
5. Ouvrez `http://localhost:3000`.

Le projet Firebase utilisé est `our-smart-budget`. Les règles Firestore sont
versionnées dans `firestore.rules`.

## Structure Firestore

- `users/{uid}` : profil et foyer de l’utilisateur ;
- `households/{householdId}` : membres du foyer ;
- `households/{householdId}/accounts` : comptes partagés ou personnels ;
- `households/{householdId}/transactions` : dépenses et revenus ;
- `households/{householdId}/goals` : projets et mensualités.

## Confidentialité

Les règles Firestore vérifient l’appartenance au foyer. Un compte personnel et
ses mouvements ne sont lisibles que par leur propriétaire.
