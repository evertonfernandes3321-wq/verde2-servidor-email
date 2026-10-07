import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carregar configuração do arquivo config.yaml ou variáveis de ambiente
function loadConfig() {
  const configPath = join(__dirname, '../../config.yaml');

  let fileConfig = {};
  try {
    const file = readFileSync(configPath, 'utf8');
    fileConfig = parse(file) || {};
  } catch {
    // Arquivo não existe, usar apenas variáveis de ambiente
  }

  return {
    // API
    port: parseInt(process.env.API_PORT || fileConfig.port || '3000', 10),
    apiKey: process.env.API_KEY || fileConfig.apiKey || '',
    jwtSecret: process.env.JWT_SECRET || fileConfig.jwtSecret || '',

    // Database
    postgres: {
      host: process.env.POSTGRES_HOST || fileConfig.postgres?.host || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || fileConfig.postgres?.port || '5432', 10),
      user: process.env.POSTGRES_USER || fileConfig.postgres?.user || 'email_user',
      password: process.env.POSTGRES_PASSWORD || fileConfig.postgres?.password || '',
      database: process.env.POSTGRES_DB || fileConfig.postgres?.database || 'email_db',
      ssl: process.env.POSTGRES_SSL === 'true' || fileConfig.postgres?.ssl === true,
    },

    // Redis
    redis: {
      host: process.env.REDIS_HOST || fileConfig.redis?.host || 'localhost',
      port: parseInt(process.env.REDIS_PORT || fileConfig.redis?.port || '6379', 10),
      password: process.env.REDIS_PASSWORD || fileConfig.redis?.password || '',
      tls: process.env.REDIS_TLS === 'true' || fileConfig.redis?.tls === true,
    },

    // SMTP
    smtp: {
      host: process.env.SMTP_HOST || fileConfig.smtp?.host || 'localhost',
      port: parseInt(process.env.SMTP_PORT || fileConfig.smtp?.port || '587', 10),
      user: process.env.SMTP_USER || fileConfig.smtp?.user || '',
      password: process.env.SMTP_PASSWORD || fileConfig.smtp?.password || '',
      secure: process.env.SMTP_SECURE === 'true' || fileConfig.smtp?.secure === true,
    },

    // Email
    emailDomain: process.env.EMAIL_DOMAIN || fileConfig.emailDomain || 'example.com',
    fromEmail: process.env.FROM_EMAIL || fileConfig.fromEmail || 'noreply@example.com',

    // Security
    security: {
      // Rate limiting (requests per minute)
      rateLimit: {
        global: parseInt(process.env.RATE_LIMIT_GLOBAL || fileConfig.security?.rateLimit?.global || '100', 10),
        perApiKey: parseInt(process.env.RATE_LIMIT_PER_KEY || fileConfig.security?.rateLimit?.perApiKey || '50', 10),
      },
      // IP allowlist for admin (CIDR format)
      adminIpAllowlist: (process.env.ADMIN_IP_ALLOWLIST || fileConfig.security?.adminIpAllowlist || '127.0.0.1/32,::1/128').split(','),
      // Session
      jwtExpiry: process.env.JWT_EXPIRY || fileConfig.security?.jwtExpiry || '24h',
      // API key
      requireApiKey: process.env.REQUIRE_API_KEY !== 'false',
    },

    // Logging
    logLevel: process.env.LOG_LEVEL || fileConfig.logLevel || 'info',
  };
}

export const config = loadConfig();

// Validar configuração crítica
function validateConfig() {
  const errors = [];

  if (!config.apiKey) {
    errors.push('API_KEY é obrigatória');
  }

  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    errors.push('JWT_SECRET deve ter pelo menos 32 caracteres');
  }

  if (!config.postgres.password) {
    errors.push('POSTGRES_PASSWORD é obrigatória');
  }

  if (!config.smtp.password) {
    errors.push('SMTP_PASSWORD é obrigatória');
  }

  if (errors.length > 0) {
    console.error('⚠️  Erros de configuração:', errors.join(', '));
  }
}

validateConfig();
