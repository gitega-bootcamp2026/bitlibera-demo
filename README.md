# ⚡ Blink API Workshop - BitLibera

Ce projet est un serveur de test développé en **Node.js (Express)** pour explorer et tester les fonctionnalités de l'API **Blink** (Réseau Lightning de Bitcoin) dans le cadre de nos ateliers pratiques.

## 🚀 Fonctionnalités
* **Génération de factures Lightning (Receive)** : Crée une facture BOLT11 avec un montant en Satoshis et un mémo personnalisé
* **Vérification du statut (Polling)** : Permet de vérifier en direct si une facture a été payée
* **Envoi de sats (Send)** : Permet d'envoyer des satoshis vers une adresse Lightning valide (`user@blink.sv`)

---

## 🛠️ Prérequis et Installation

1. Assure-toi d'avoir **Node.js** installé sur ta machine.
2. Clone ou télécharge ce dépôt sur ton ordinateur.
3. Installe les dépendances nécessaires en exécutant dans ton terminal :
   ```bash
   npm install
   ```

## Lancer la démo

Node.js 22.13 ou plus récent est requis pour SQLite natif.

```bash
npm start
```

Ouvrez ensuite http://localhost:3000. Le mode démo permet de créer des factures fictives, de simuler leur paiement et d’envoyer des paiements simulés. Les opérations sont conservées dans `data/bitlibera.sqlite`.

Avant le premier lancement, renseignez `APP_USERNAME`, `APP_PASSWORD` et `APP_SESSION_SECRET` dans votre fichier `.env` (copiez `.env.example` si nécessaire). Choisissez vos propres identifiants et une longue valeur aléatoire pour le secret de session; le serveur refuse l’accès sans ces trois valeurs. Redémarrez ensuite le serveur et ouvrez http://localhost:3000 pour vous connecter.

La section **BitLibera** propose aussi les parcours On-Ramp et Off-Ramp. En démo, l’OTP de test est `123456`; les commandes fictives sont enregistrées dans la même base SQLite. En mode réel, les requêtes utilisent l’API Gateway BitLibera et nécessitent `BITLIBERA_API_KEY`.

Pour utiliser Blink en réel, copiez `.env.example` vers `.env`, puis renseignez `BLINK_WALLET_ID` et `BLINK_API_KEY`. Les identifiants ne sont utilisés que par le serveur. Une facture de démo n’est pas une facture Lightning payable.
   