# ==============================================================================
# Shopify Promo Switcher - Dockerfile
# ==============================================================================
FROM node:20-alpine AS base

WORKDIR /app

# Installer uniquement les dépendances de production
COPY package*.json ./
RUN npm ci --omit=dev

# Copier le code source et les fichiers publics
COPY src/ ./src/
COPY public/ ./public/

# Créer le répertoire de données persistant
RUN mkdir -p /app/data && chown -R node:node /app

# Exécuter en tant qu'utilisateur non-root pour la sécurité
USER node

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Vérification de santé (healthcheck)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "src/server.js"]
