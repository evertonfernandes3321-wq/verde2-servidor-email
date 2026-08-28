import { config } from '../config/index.js';
import { query } from '../db/postgres.js';
import { log } from '../utils/logger.js';
import crypto from 'crypto';

// Hash da API Key (SHA-256)
function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

// Validar API Key no banco de dados
async function validateApiKeyFromDb(apiKey) {
  const keyHash = hashApiKey(apiKey);

  try {
    const result = await query(
      `SELECT
          ak.id,
          ak.name,
          ak.rate_limit,
          ak.daily_limit,
          ak.is_active,
          ak.expires_at,
          t.id as tenant_id,
          t.slug as tenant_slug,
          t.plan,
          t.is_active as tenant_is_active,
          t.settings as tenant_settings
       FROM api_keys ak
       JOIN tenants t ON ak.tenant_id = t.id
       WHERE ak.key_hash = $1 AND ak.is_active = true`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    // Verificar se tenant está ativo
    if (!row.tenant_is_active) {
      return null;
    }

    // Verificar expiração da API Key
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return null;
    }

    // Buscar domínios permitidos do tenant
    const domainsResult = await query(
      'SELECT domain FROM tenant_domains WHERE tenant_id = $1 AND is_verified = true',
      [row.tenant_id]
    );

    const allowedEmailDomains = domainsResult.rows.map(r => r.domain);

    return {
      id: row.id,
      name: row.name,
      rateLimit: row.rate_limit,
      dailyLimit: row.daily_limit,
      tenantId: row.tenant_id,
      tenantSlug: row.tenant_slug,
      tenantPlan: row.plan,
      tenantSettings: row.tenant_settings,
      allowedEmailDomains,
      isActive: row.is_active,
    };
  } catch (err) {
    log.error({ err }, 'Erro ao validar API Key');
    return null;
  }
}

// Middleware de autenticação
export async function authMiddleware(request, reply) {
  const authHeader = request.headers.authorization;

  // Verificar se Authorization header está presente
  if (!authHeader) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Cabeçalho de autorização ausente',
    });
  }

  // Verificar formato Bearer
  if (!authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Formato de autorização inválido. Use: Bearer <token>',
    });
  }

  const token = authHeader.substring(7);

  if (!token) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Token não fornecido',
    });
  }

  let authResult = null;

  // Determinar tipo de autenticação
  if (token.startsWith('ek_') || token.startsWith('pk_')) {
    // É uma API Key
    authResult = await validateApiKeyFromDb(token);
    request.authType = 'api_key';
  } else if (token.startsWith('eyJ')) {
    // É um JWT (para admin)
    authResult = await validateJwt(token);
    request.authType = 'jwt';
  } else {
    // Tentar como API Key
    authResult = await validateApiKeyFromDb(token);
    request.authType = 'api_key';
  }

  if (!authResult) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Token de autenticação inválido ou expirado',
    });
  }

  if (!authResult.isActive) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'API Key inativa. Contate o administrador.',
    });
  }

  // Attach user info to request
  request.apiKeyId = authResult.id;
  request.apiKeyName = authResult.name;
  request.tenantId = authResult.tenantId;
  request.tenantSlug = authResult.tenantSlug;
  request.tenantPlan = authResult.tenantPlan;
  request.tenantSettings = authResult.tenantSettings;
  request.allowedEmailDomains = authResult.allowedEmailDomains;
  request.rateLimit = authResult.rateLimit;
  request.dailyLimit = authResult.dailyLimit;

  // Log de uso da API Key
  try {
    await query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
      [authResult.id]
    );
  } catch (err) {
    log.error({ err }, 'Erro ao atualizar last_used_at');
  }
}

// Validar JWT
async function validateJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

    // Verificar expiração
    if (payload.exp && payload.exp < Date.now() / 1000) {
      return null;
    }

    // Verificar se é um admin token
    if (payload.type !== 'admin') {
      return null;
    }

    // Verificar assinatura
    const cryptoModule = await import('crypto');
    const expectedSignature = cryptoModule
      .createHmac('sha256', config.jwtSecret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');

    if (expectedSignature !== parts[2]) {
      return null;
    }

    // Buscar tenant do admin
    const tenantResult = await query(
      "SELECT id, slug, plan, is_active, settings FROM tenants WHERE slug = 'root' LIMIT 1"
    );

    if (tenantResult.rows.length === 0 || !tenantResult.rows[0].is_active) {
      return null;
    }

    const tenant = tenantResult.rows[0];

    return {
      id: payload.sub,
      name: payload.name,
      isActive: true,
      isAdmin: true,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      tenantPlan: tenant.plan,
      tenantSettings: tenant.settings,
      allowedEmailDomains: [],
    };
  } catch (err) {
    log.error({ err }, 'Erro ao validar JWT');
    return null;
  }
}

// Decorator para verificar IP do admin
export function adminIpCheck(request, reply, done) {
  const allowedIps = config.security.adminIpAllowlist;

  if (!allowedIps || allowedIps.length === 0) {
    return done();
  }

  const clientIp = request.ip;
  const isAllowed = allowedIps.some(allowed => ipInRange(clientIp, allowed));

  // Aplic apenas em rotas de admin
  if (!isAllowed && request.url.startsWith('/admin')) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Acesso não permitido a partir deste IP',
    });
  }

  done();
}

// Função simples para verificar IP em range (CIDR)
function ipInRange(ip, cidr) {
  if (cidr === ip) return true;

  const [range, bits] = cidr.split('/');
  if (!bits) return ip === range;

  const mask = ~(2 ** (32 - bits) - 1);
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(range);

  return (ipInt & mask) === (rangeInt & mask);
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

// Rate limiter por API Key
export async function rateLimitPerKey(request, reply) {
  if (!request.apiKeyId) {
    return;
  }

  const { cache } = await import('../db/redis.js');

  try {
    // Rate limit por minuto
    const minuteKey = `ratelimit:min:${request.apiKeyId}`;
    const currentMin = await cache.incr(minuteKey);

    if (currentMin === 1) {
      await cache.expire(minuteKey, 60);
    }

    if (currentMin > request.rateLimit) {
      return reply.code(429).send({
        error: 'Too Many Requests',
        message: `Limite de ${request.rateLimit} requisições por minuto excedido`,
        retryAfter: 60,
      });
    }

    // Rate limit diário
    const today = new Date().toISOString().split('T')[0];
    const dailyKey = `ratelimit:day:${request.apiKeyId}:${today}`;

    if (request.dailyLimit) {
      const currentDay = await cache.get(dailyKey) || 0;

      if (parseInt(currentDay, 10) >= request.dailyLimit) {
        return reply.code(429).send({
          error: 'Too Many Requests',
          message: `Limite diário de ${request.dailyLimit} emails excedido`,
          retryAfter: 86400,
        });
      }

      await cache.incr(dailyKey);
      if (parseInt(currentDay, 10) === 0) {
        await cache.expire(dailyKey, 86400);
      }
    }

    // Headers
    reply.header('X-RateLimit-Limit', request.rateLimit);
    reply.header('X-RateLimit-Remaining', Math.max(0, request.rateLimit - currentMin));
    reply.header('X-RateLimit-Reset', Math.floor(Date.now() / 1000) + 60);
  } catch (err) {
    log.error({ err }, 'Erro no rate limit');
  }
}

// Decorator para verificar plano do tenant
export function requirePlan(...allowedPlans) {
  return async (request, reply, done) => {
    const planHierarchy = ['free', 'starter', 'professional', 'enterprise'];
    const userPlanIndex = planHierarchy.indexOf(request.tenantPlan);
    const requiredIndex = Math.min(...allowedPlans.map(p => planHierarchy.indexOf(p)));

    if (userPlanIndex < requiredIndex) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: `Plano '${request.tenantPlan}' não tem acesso a este recurso. Required: ${allowedPlans.join(' ou ')}`,
      });
    }

    done();
  };
}
