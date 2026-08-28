import { config } from '../config/index.js';
import { log } from '../utils/logger.js';
import crypto from 'crypto';

// Security headers com Fastify
export async function securityHeaders(fastify) {
  // Adicionar hooks para todos os requests
  fastify.addHook('onRequest', async (request, reply) => {
    // Headers de segurança
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    // Prevent clickjacking
    reply.header('Content-Security-Policy', "frame-ancestors 'none'");

    // Remove server identification
    reply.header('X-Powered-By', undefined);

    // Request ID para tracing
    const requestId = request.headers['x-request-id'] || crypto.randomUUID();
    reply.header('X-Request-ID', requestId);
    request.requestId = requestId;
  });
}

// Sanitização de inputs
export function sanitizeInput(data) {
  if (typeof data === 'string') {
    // Remover caracteres de controle
    return data.replace(/[\x00-\x1F\x7F]/g, '').trim();
  }

  if (typeof data === 'object' && data !== null) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      sanitized[key] = sanitizeInput(value);
    }
    return sanitized;
  }

  return data;
}

// Validar email
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;

  // RFC 5322 simplificado
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

  return emailRegex.test(email) && email.length <= 254;
}

// Validar domínio de email (prevenir email spoofing interno)
export function isAllowedEmailDomain(email, allowedDomains) {
  if (!allowedDomains || allowedDomains.length === 0) {
    return true; // Sem restrição
  }

  const domain = email.split('@')[1]?.toLowerCase();
  return allowedDomains.some(d => d.toLowerCase() === domain);
}

// Rate limiting por IP
export function createIpRateLimiter(redis) {
  const windowMs = 60 * 1000; // 1 minuto
  const maxRequests = config.security.rateLimit.global;

  return async (ip) => {
    try {
      const key = `ip_ratelimit:${ip}`;
      const current = await redis.incr(key);

      if (current === 1) {
        await redis.expire(key, 60);
      }

      return {
        allowed: current <= maxRequests,
        remaining: Math.max(0, maxRequests - current),
        resetIn: 60,
      };
    } catch (err) {
      log.error({ err }, 'Erro no rate limit por IP');
      return { allowed: true, remaining: maxRequests, resetIn: 60 };
    }
  };
}

// Detectar padrões de ataque
export function detectAttackPatterns(request) {
  const suspiciousPatterns = [
    /\.\.\//,           // Path traversal
    /<script/i,         // XSS
    /javascript:/i,     // XSS
    /on\w+\s*=/i,       // Event handlers XSS
    /union\s+select/i,  // SQL Injection
    /exec\s*\(/i,       // Command Injection
    /\$\(.*\)/,         // Command Injection
    /\$\{.*\}/,         // Template injection
  ];

  const bodyStr = JSON.stringify(request.body || {});
  const queryStr = JSON.stringify(request.query || {});
  const paramsStr = JSON.stringify(request.params || {});

  const allContent = bodyStr + queryStr + paramsStr;

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(allContent)) {
      log.warn({
        pattern: pattern.source,
        ip: request.ip,
        url: request.url,
      }, 'Padrão de ataque detectado');

      return true;
    }
  }

  return false;
}

// Hook de proteção
export async function protectionHook(request, reply) {
  // 1. Verificar tamanho do body
  const contentLength = parseInt(request.headers['content-length'] || '0', 10);
  const maxBodySize = 1024 * 1024; // 1MB

  if (contentLength > maxBodySize) {
    return reply.code(413).send({
      error: 'Payload Too Large',
      message: 'Requisição muito grande',
    });
  }

  // 2. Detectar ataques
  if (detectAttackPatterns(request)) {
    return reply.code(400).send({
      error: 'Bad Request',
      message: 'Requisição contém padrões suspeitos',
    });
  }

  // 3. Sanitizar inputs (exceto senhas)
  if (request.body && typeof request.body === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(request.body)) {
      if (key.toLowerCase().includes('password') ||
          key.toLowerCase().includes('secret') ||
          key.toLowerCase().includes('token')) {
        sanitized[key] = value; // Não sanitizar senhas
      } else {
        sanitized[key] = sanitizeInput(value);
      }
    }
    request.body = sanitized;
  }
}

// Logging de segurança
export function securityLogger(fastify) {
  fastify.addHook('onResponse', async (request, reply) => {
    const logSecurityEvents = ['/admin', '/api/keys', '/settings'];

    const shouldLog = logSecurityEvents.some(path => request.url.startsWith(path));

    if (shouldLog || reply.statusCode >= 400) {
      log.info({
        requestId: request.requestId,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        apiKeyId: request.apiKeyId,
      }, 'Security event');
    }
  });
}
