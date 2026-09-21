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
   