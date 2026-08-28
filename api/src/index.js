import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { config } from './config/index.js';
import { log } from './utils/logger.js';
import { emailQueue } from './services/queue.js';
import { healthRoutes } from './routes/health.js';
import { sendRoutes } from './routes/send.js';
import { templateRoutes } from './routes/templates.js';
import { logRoutes } from './routes/logs.js';
import { statsRoutes } from './routes/stats.js';
import { securityHeaders, protectionHook, securityLogger } from './plugins/security.js';
import { authMiddleware, adminIpCheck, rateLimitPerKey } from './plugins/auth.js';

const fastify = Fastify({
  logger: log,
  trustProxy: true, // Para pegar IP real atrás de proxy
});

// ============================================
// SECURITY: Headers e Proteção
// ============================================
await fastify.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// CORS restritivo
await fastify.register(cors, {
  origin: (origin, callback) => {
    // Em produção, liste os domínios permitidos
    const allowedOrigins = process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(',')
      : [];

    // Allow localhost for development
    if (!origin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      return callback(null, true);
    }

    // Check allowed origins
    if (allowedOrigins.length > 0 && allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Em produção, reject por padrão
    if (process.env.NODE_ENV === 'production') {
      callback(new Error('Not allowed by CORS'), false);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
  maxAge: 86400, // 24 hours
});

// Rate limiting global
await fastify.register(rateLimit, {
  max: config.security.rateLimit.global,
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    // Rate limit por IP + API Key se disponível
    return request.apiKeyId || request.ip;
  },
  errorResponseBuilder: (request, context) => ({
    error: 'Too Many Requests',
    message: `Limite de ${context.max} requisições por minuto excedido`,
    retryAfter: context.after,
  }),
});

// ============================================
// SECURITY: Hooks de proteção
// ============================================

// Headers de segurança
fastify.addHook('preHandler', securityHeaders);

// Proteção contra ataques
fastify.addHook('preHandler', protectionHook);

// Log de segurança
fastify.addHook('preHandler', securityLogger);

// Check IP do admin
fastify.addHook('preHandler', adminIpCheck);

// Rate limit por API Key
fastify.addHook('preHandler', rateLimitPerKey);

// ============================================
// ROTAS PÚBLICAS (sem auth)
// ============================================
await fastify.register(healthRoutes);

// ============================================
// ROTAS AUTENTICADAS
// ============================================

// Auth middleware para rotas protegidas
async function authenticatedRoutes(fastify) {
  fastify.addHook('preHandler', authMiddleware);

  // Rotas de envio
  await fastify.register(sendRoutes, { prefix: '/send' });

  // Rotas de templates
  await fastify.register(templateRoutes, { prefix: '/templates' });

  // Rotas de logs
  await fastify.register(logRoutes, { prefix: '/logs' });

  // Rotas de estatísticas
  await fastify.register(statsRoutes, { prefix: '/stats' });
}

// Registrar rotas autenticadas
await fastify.register(async function (fastify) {
  await fastify.register(authenticatedRoutes, { prefix: '/api/v1' });
});

// ============================================
// ERROR HANDLER
// ============================================

fastify.setErrorHandler((error, request, reply) => {
  // Log do erro
  log.error({
    err: error,
    requestId: request.requestId,
    url: request.url,
    method: request.method,
  }, 'Request error');

  // Erros conhecidos
  if (error.statusCode === 401) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Autenticação necessária',
    });
  }

  if (error.statusCode === 403) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Acesso negado',
    });
  }

  if (error.statusCode === 404) {
    return reply.code(404).send({
      error: 'Not Found',
      message: 'Rota não encontrada',
    });
  }

  if (error.validation) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: 'Dados inválidos',
      details: error.validation,
    });
  }

  // Erro interno (não expor detalhes em produção)
  if (process.env.NODE_ENV === 'production') {
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Erro interno do servidor',
      requestId: request.requestId,
    });
  }

  return reply.code(error.statusCode || 500).send({
    error: 'Internal Server Error',
    message: error.message,
    stack: error.stack,
  });
});

// ============================================
// SHUTDOWN
// ============================================

// Hook de shutdown para limpar recursos
fastify.addHook('onClose', async () => {
  log.info('Encerrando servidor...');
  await emailQueue.close();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log.info('SIGTERM recebido, encerrando...');
  await fastify.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT recebido, encerrando...');
  await fastify.close();
  process.exit(0);
});

// ============================================
// START
// ============================================

const start = async () => {
  try {
    // Verificar configurações críticas
    if (!config.apiKey) {
      throw new Error('API_KEY não configurada');
    }

    await fastify.listen({ port: config.port, host: '0.0.0.0' });

    log.info({
      port: config.port,
      env: process.env.NODE_ENV || 'development',
    }, 'Servidor iniciado');

    log.info('Security: Headers, Rate Limiting, IP Check, Attack Detection ativados');

  } catch (err) {
    log.error(err);
    process.exit(1);
  }
};

start();
