# ============================================
# Dockerfile - Verde2 Email API
# ============================================

# Build multi-stage para reduzir tamanho
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar apenas arquivos necessários para install
COPY package*.json ./

# Instalar dependências
RUN npm ci --only=production

# ============================================
# Imagem final
# ============================================
FROM node:20-alpine

WORKDIR /app

# Instalar dependências do sistema
RUN apk add --no-cache \
    dumb-init \
    ca-certificates \
    && rm -rf /var/cache/apk/*

# Copiar node_modules e código do builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY src/ ./src/

# Criar usuário não-root com UID/GID fixos
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Permissões corretas
RUN chown -R nodejs:nodejs /app

# Usar dumb-init para sinais corretos
ENTRYPOINT ["dumb-init", "--"]

# Trocar para usuário não-root
USER nodejs

# Expor porta
EXPOSE 3000

# Variáveis de ambiente
ENV NODE_ENV=production \
    PORT=3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health/live', (r) => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Limitar recursos
# (Configurado no docker-compose.yml)

# Iniciar aplicação
CMD ["node", "src/index.js"]
