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