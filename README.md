# 🏷️ Shopify Promo Switcher

Application Web interne légère, ultra-sécurisée et infaillible permettant à l'équipe marketing et à la direction d'activer ou d'arrêter une remise globale en pourcentage sur **tous les produits actifs** d'une boutique Shopify, avec **mode simulation (Dry-Run)**, sauvegarde automatique et **restauration exacte** des prix d'origine.

---

## 📋 Table des matières

1. [Nouveautés & Points forts](#-nouveautés--points-forts)
2. [Authentification par Liste Blanche & Code Secret Personnel](#-authentification-par-liste-blanche--code-secret-personnel)
3. [Mode Test / Simulation (Dry-Run)](#-mode-test--simulation-dry-run)
4. [Algorithme de calcul des prix & Sauvegarde](#-algorithme-de-calcul-des-prix--sauvegarde)
5. [Guide de configuration Shopify](#-guide-de-configuration-shopify)
6. [Installation et lancement local](#-installation-et-lancement-local)
7. [Déploiement Docker & Docker Compose](#-déploiement-docker--docker-compose)
8. [Guide d'utilisation (Équipe Marketing)](#-guide-dutilisation-équipe-marketing)
9. [Dépannage & Procédures de secours](#-dépannage--procédures-de-secours)

---

## ✨ Nouveautés & Points forts

- 🔑 **Zéro mot de passe unique partagé & Zéro configuration OAuth externe** : Chaque collaborateur autorisé se connecte avec son **adresse email professionnelle** et son **code secret personnel** défini dans `.env`.
- 🧪 **Mode Test / Simulation (Dry-Run)** : Testez sur votre **vrai catalogue Shopify** en lecture seule sans JAMAIS risquer d'altérer vos prix en direct. Un tableau d'aperçu des 15 premiers articles vous permet de vérifier les calculs au centime près.
- 🗄️ **Sauvegarde intégrale avant mutation** : Un instantané complet (`./data/price-backup.json`) de tous les prix et prix barrés est vérifié et écrit sur disque *avant* qu'un seul centime ne soit modifié sur Shopify.
- ⛔ **Verrouillage anti-double remise** : Dès qu'une promotion (réelle ou simulation) est active ou qu'une sauvegarde est présente, l'activation d'une seconde remise est strictement bloquée.
- ↩️ **Restauration exacte** : Remet à l'identique les `price` et `compare_at_price` (y compris la réinitialisation à vide pour les articles qui n'avaient pas de prix barré avant la vente).
- 🏷️ **Plafond de sécurité** : Remise configurable entre **5 %** et **70 %** maximum.
- 🚀 **Gestion du débit Shopify (Throttling)** : Analyse en temps réel des extensions de coût GraphQL pour ne jamais dépasser le quota de requêtes de l'API Shopify.

---

## 🛡️ Authentification par Liste Blanche & Code Secret Personnel

Aucun mot de passe unique n'est partagé entre les équipes. L'accès est configuré via la variable `AUTHORIZED_USERS` dans votre fichier `.env`.

### Format de configuration dans `.env`
Indiquez des paires `email:codeSecret` séparées par des virgules :

```env
AUTHORIZED_USERS=marketing@domaine.com:CodeSecret123,patron@domaine.com:CodeBoss456,achraf@domaine.com:MonCode789
```

### Fonctionnement de la sécurité
1. L'utilisateur saisit son email professionnel et son code secret.
2. Le serveur valide l'association exacte de manière insensible à la casse pour l'email.
3. Si les identifiants sont valides, un cookie de session chiffré `HttpOnly` / `SameSite=Strict` (`auth_token`, valable 12 heures) est émis.
4. L'email de la personne ayant déclenché ou arrêté une promotion est systématiquement consigné dans `data/state.json` et dans le journal d'audit `data/audit.log`.

---

## 🧪 Mode Test / Simulation (Dry-Run)

Le mode Dry-Run permet de tester l'application en toute sérénité sur votre boutique Shopify sans toucher aux prix réels affichés à vos clients.

### 1. Activer le mode Dry-Run par défaut via `.env`
Pour vos tests locaux ou pré-production, activez dans `.env` :
```env
DRY_RUN=true
```
Lorsque `DRY_RUN=true`, le serveur force l'exécution en mode simulation : **aucune mutation d'écriture n'est envoyée à Shopify**.

### 2. Basculer entre simulation et mode réel dans l'interface
Si `DRY_RUN=false` dans `.env`, vous disposez d'un bouton interrupteur directement sur l'interface :
> **🧪 Mode Test / Simulation (vérifier le calcul sur mes vrais produits sans modifier la boutique)**

### Ce qui se passe lors d'une simulation :
1. L'application interroge l'API GraphQL Shopify en **lecture seule** pour récupérer tous les produits actifs et leurs variantes.
2. Elle génère la sauvegarde complète dans `data/price-backup.json` (marquée comme simulation).
3. Elle calcule tous les prix remisés et les prix barrés selon les règles métier.
4. Elle enregistre le résultat complet dans `data/last-simulation.json`.
5. Elle affiche immédiatement un **tableau des 15 premiers articles** avec leurs anciens et nouveaux tarifs pour vérification visuelle.
6. L'opération d'arrêt réinitialise simplement l'état sans appeler l'API Shopify.

---

## 🧮 Algorithme de calcul des prix & Sauvegarde

### 1. Détermination du prix de base
Pour chaque variante d'un produit actif :
- Si `compareAtPrice` existe et est strictement supérieur à `price` : **prix de base = `compareAtPrice`**.
- Sinon : **prix de base = `price`**, et `compareAtPrice` initial est enregistré comme le prix normal.

### 2. Calcul de la remise
$$\text{Nouveau Prix} = \text{round}\left(\text{Prix de Base} \times \left(1 - \frac{\text{Remise}}{100}\right)\right)$$
*Calculé en centimes entiers pour éviter toute dérive de virgule flottante.*

### 3. Protection `NEVER_INCREASE_PRICE` (activée par défaut)
Si un article est par exemple soldé à 50 € avec un prix barré de 100 €, et qu'on active une promo à -20 % (qui donnerait 80 €), l'article reste maintenu à 50 € afin de ne léser aucun client.

### 4. Exclusion des cartes cadeaux
Les produits de type `isGiftCard: true` ne sont jamais remisés.

---

## 🛍️ Guide de configuration Shopify (Client Credentials Grant)

L'application utilise le flux officiel d'authentification Shopify **Client Credentials Grant** avec votre **Client ID** et votre **Client Secret** :

1. Rendez-vous sur votre [Shopify Dev Dashboard](https://dev.shopify.com/dashboard/) (ou votre Partner Dashboard).
2. Créez ou sélectionnez votre application.
3. Sous **Versions de l'application**, assurez-vous d'avoir accordé les accès suivants :
   - `read_products` (lecture du catalogue)
   - `write_products` (mise à jour des prix)
4. Installez l'application sur votre boutique Shopify.
5. Dans **Paramètres** de l'application, copiez votre **Client ID** et votre **Client Secret**.
6. Renseignez dans votre `.env` :
   ```env
   SHOPIFY_STORE_DOMAIN=votre-boutique.myshopify.com
   SHOPIFY_CLIENT_ID=votre_client_id
   SHOPIFY_CLIENT_SECRET=votre_client_secret
   SHOPIFY_API_VERSION=2025-01
   ```
   *L'application échange automatiquement ces identifiants contre un jeton d'accès temporaire via `POST https://{shop}.myshopify.com/admin/oauth/access_token` et le conserve en mémoire cache avec rafraîchissement automatique.*

---

## 💻 Installation et lancement local

### 1. Cloner et installer les dépendances
```bash
cd promoKEA
npm install
```

### 2. Configurer le fichier `.env`
Copiez le modèle et renseignez vos valeurs :
```bash
cp .env.example .env
```

Générez une clé secrète pour les sessions JWT :
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```
Placez ce résultat dans `JWT_SECRET`.

Exemple de `.env` pour test local (Simulation active) :
```env
PORT=3000
SHOPIFY_STORE_DOMAIN=ma-boutique.myshopify.com
SHOPIFY_CLIENT_ID=votre_client_id_ici
SHOPIFY_CLIENT_SECRET=votre_client_secret_ici
SHOPIFY_API_VERSION=2025-01
AUTHORIZED_USERS=marketing@domaine.com:MonCodePromo2026,direction@domaine.com:SecretAdmin99
JWT_SECRET=f391e48f76d2994e6bf7651a2d5930bc2c462719a7ce8b23c52a0a25690b2308
DRY_RUN=true
COOKIE_SECURE=auto
```

### 3. Exécuter les tests unitaires
```bash
npm test
```
*Vérifie le calcul des remises, les arrondis au centime et les verrouillages (plafond 70%).*

### 4. Démarrer le serveur
Mode développement :
```bash
npm run dev
```
Mode production :
```bash
npm start
```
Ouvrez ensuite votre navigateur sur [http://localhost:3000](http://localhost:3000).

---

---

## ⚡ Déploiement sur Vercel + Neon PostgreSQL (100% Gratuit)

Vous pouvez déployer cette application sur **Vercel** avec une base de données **Neon** en moins de 3 minutes :

### 1. Créer une base de données gratuite sur Neon
1. Rendez-vous sur [neon.tech](https://neon.tech) et créez un compte gratuit.
2. Créez un nouveau projet (ex: `promo-kea`).
3. Copiez la chaîne de connexion PostgreSQL (`postgresql://user:password@ep-...neon.tech/neondb?sslmode=require`).

### 2. Déployer sur Vercel
1. Poussez votre code sur votre compte GitHub.
2. Importez le projet sur [vercel.com](https://vercel.com).
3. Dans la section **Environment Variables**, ajoutez :
   - `SHOPIFY_STORE_DOMAIN`
   - `SHOPIFY_CLIENT_ID`
   - `SHOPIFY_CLIENT_SECRET`
   - `SHOPIFY_API_VERSION` (`2026-01`)
   - `AUTHORIZED_USERS`
   - `JWT_SECRET`
   - `DATABASE_URL` (votre URL Neon)
4. Cliquez sur **Deploy** !

L'application crée automatiquement ses tables (`promo_state`, `price_backups`, `audit_logs`) au premier démarrage. Les dates et heures exactes de chaque action y sont enregistrées automatiquement.

## 👩‍💼 Guide d'utilisation (Équipe Marketing)

1. **Connexion** :
   - Saisissez votre adresse email professionnelle et votre code secret personnel.
   - Cliquez sur **"Se connecter"**.

2. **Tester d'abord en Simulation** :
   - Cochez l'interrupteur **"🧪 Mode Test / Simulation"**.
   - Choisissez une remise (ex: **-30%**).
   - Cliquez sur le bouton violet **"Tester la remise -30% en simulation"**.
   - Consultez le tableau des 15 premiers articles pour vérifier les prix calculés.
   - Cliquez sur **"Clôturer le mode simulation"** une fois la vérification terminée.

3. **Activer la promotion réelle** :
   - Décochez le mode simulation pour basculer en mode réel.
   - Cliquez sur le bouton vert **"Appliquer -X% sur tous les produits"**.
   - Confirmez dans la boîte de dialogue.
   - Le bandeau orange s'affiche : vos clients voient désormais les prix soldés avec prix barrés.

4. **Arrêter la promotion (Fin des soldes)** :
   - Cliquez sur le bouton rouge **"Arrêter la promo & Restaurer les prix d'origine"**.
   - Confirmez la restauration.
   - Tous les articles retrouvent instantanément leurs prix d'origine.
