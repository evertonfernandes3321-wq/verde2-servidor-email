# Servidor de Email Transacional - Verde2

Servidor de email transacional auto-hospedado para uso nos aplicativos do ecossistema IAVerde.

## Funcionalidades

- **API REST** para envio de emails transacionais
- **Sistema de Templates** com variáveis dinâmicas (Handlebars)
- **Filas de processamento** com Redis para confiabilidade
- **Logs detalhados** de todos os envios
- **Estatísticas** em tempo real
- **Autenticação** via API Key
- **Suporte a DKIM** para entregabilidade

## Arquitetura

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   API       │────▶│   Redis     │────▶│  Postfix    │
│  (Fastify)  │     │   (Queue)  │     │   (SMTP)    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐
│  PostgreSQL │     │  OpenDKIM   │
│   (Dados)   │     │  (Assinatura)
└─────────────┘     └─────────────┘
```

## Requisitos

- Docker e Docker Compose
- Node.js 20+ (para desenvolvimento local)
- Um domínio configurado

## Quick Start

### 1. Configuração Inicial

```bash
# Copiar arquivo de exemplo de configuração
cp .env.example .env
cp config.example.yaml config.yaml

# Editar os arquivos .env e config.yaml com suas configurações
```

### 2. Iniciar os Serviços

```bash
# Iniciar todos os serviços
docker-compose up -d

# Ver logs
docker-compose logs -f

# Ver status
docker-compose ps
```

### 3. Verificar Saúde

```bash
# Health check
curl http://localhost:3000/health
```

## Configuração

### Variáveis de Ambiente (.env)

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `API_PORT` | Porta da API | 3000 |
| `API_KEY` | Chave de API para autenticação | - |
| `POSTGRES_USER` | Usuário do banco de dados | email_user |
| `POSTGRES_PASSWORD` | Senha do banco de dados | - |
| `POSTGRES_DB` | Nome do banco de dados | email_db |
| `REDIS_HOST` | Host do Redis | redis |
| `SMTP_USER` | Usuário SMTP | relay_user |
| `SMTP_PASSWORD` | Senha SMTP | - |
| `EMAIL_DOMAIN` | Domínio do email | example.com |
| `FROM_EMAIL` | Email remetente padrão | noreply@example.com |

## API Reference

### Autenticação

Todas as requisições devem incluir o header:
```
Authorization: Bearer <SUA_API_KEY>
```

### Endpoints

#### Enviar Email

```bash
POST /api/v1/send
```

```json
{
  "to": "usuario@exemplo.com",
  "template": "welcome-email",
  "variables": {
    "name": "João",
    "resetUrl": "https://app.exemplo.com/reset/abc123"
  }
}
```

#### Criar Template

```bash
POST /api/v1/templates
```

```json
{
  "slug": "welcome-email",
  "subject": "Bem-vindo, {{name}}!",
  "body_html": "<h1>Olá, {{name}}!</h1><p>Bem-vindo ao nosso app.</p>",
  "body_text": "Olá, {{name}}! Bem-vindo ao nosso app.",
  "from_name": "Equipe IAVerde"
}
```

#### Listar Logs

```bash
GET /api/v1/logs?page=1&limit=50&status=sent
```

#### Estatísticas

```bash
GET /api/v1/stats
GET /api/v1/stats/daily?days=30
GET /api/v1/stats/templates
```

## Templates

O sistema usa **Handlebars** para renderização de templates.

### Variáveis Disponíveis

```handlebars
{{name}}          - Substitui pela variável
{{#if condition}} - Condicional
{{#each items}}   - Loop
{{> partial}}     - Partial
```

### Exemplo de Template

```json
{
  "slug": "welcome-email",
  "subject": "Bem-vindo ao {{appName}}, {{name}}!",
  "body_html": "<html><body><h1>Olá, {{name}}!</h1><p>Obrigado por se registrar no {{appName}}.</p></body></html>",
  "from_name": "Equipe IAVerde"
}
```

## Desenvolvimento Local

### Sem Docker

```bash
# Instalar dependências
cd api
npm install

# Configurar banco de dados PostgreSQL e Redis localmente
# Editar config.yaml com as configurações locais

# Executar migrations
npm run migrate

# Iniciar API
npm run dev
```

### Com Docker

```bash
# Build das imagens
docker-compose build

# Iniciar serviços
docker-compose up -d

# Ver logs de um serviço específico
docker-compose logs -f api
```

## Deploy em Produção

### 1. Configurar DNS

Adicione os seguintes registros DNS:

```
# Registro A
mail.seudominio.com -> IP_DO_SERVIDOR

# Registro MX
@ -> mail.seudominio.com (prioridade 10)

# Registro SPF
@ -> v=spf1 mx ~all

# Registro DKIM
selector._domainkey -> v=DKIM1; k=rsa; p=CHAVE_PUBLICA_DKIM

# Registro DMARC
_dmarc -> v=DMARC1; p=quarantine; rua=mailto:dmarc@seudominio.com
```

### 2. Gerar Chaves DKIM

```bash
# Linux/Mac
chmod +x scripts/generate-dkim.sh
./scripts/generate-dkim.sh seu-dominio.com mail
```

### 3. Configurar Firewall

```bash
# Ubuntu
sudo ufw allow 22    # SSH
sudo ufw allow 80    # HTTP
sudo ufw allow 443   # HTTPS
sudo ufw allow 25    # SMTP
sudo ufw allow 587   # SMTP TLS
sudo ufw enable
```

### 4. Variáveis de Produção

Defina todas as variáveis de ambiente no arquivo `.env` com valores seguros:
- Use senhas fortes (gere com `openssl rand -base64 32`)
- Configure o domínio real
- Configure a API Key real

## Monitoramento

### Logs

```bash
# Ver logs da API
docker-compose logs -f api

# Ver logs do PostgreSQL
docker-compose logs -f postgres

# Ver logs do Redis
docker-compose logs -f redis
```

### Métricas

Acesse `/api/v1/stats` para ver:
- Total de emails enviados
- Taxa de sucesso
- Emails por dia
- Emails por template

## Troubleshooting

### Email não é entregue

1. Verificar logs: `docker-compose logs postfix`
2. Verificar se o DNS está configurado corretamente
3. Testar entregabilidade: https://www.mail-tester.com/
4. Verificar spam da caixa de destino

### Erro de conexão SMTP

1. Verificar se o Postfix está rodando: `docker-compose ps`
2. Verificar portas: `docker-compose logs postfix`
3. Verificar credenciais no .env

### Erro de banco de dados

1. Verificar se PostgreSQL está rodando
2. Verificar logs: `docker-compose logs postgres`
3. Executar migrations: `docker-compose exec api npm run migrate`

## Licença

MIT
