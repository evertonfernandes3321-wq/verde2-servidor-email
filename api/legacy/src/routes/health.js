import { verifySmtpConnection } from '../services/email.js';
import { pool } from '../db/postgres.js';
import { redis } from '../db/redis.js';

export async function healthRoutes(fastify) {
  // Health check principal
  fastify.get('/health', async (request, reply) => {
    const checks = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {},
    };

    // Verificar PostgreSQL
    try {
      await pool.query('SELECT 1');
      checks.services.postgres = 'healthy';
    } catch (err) {
      checks.services.postgres = 'unhealthy';
      checks.status = 'degraded';
    }

    // Verificar Redis
    try {
      await redis.ping();
      checks.services.redis = 'healthy';
    } catch (err) {
      checks.services.redis = 'unhealthy';
      checks.status = 'degraded';
    }

    // Verificar SMTP (opcional, apenas verificar se configurado)
    try {
      const smtpOk = await verifySmtpConnection();
      checks.services.smtp = smtpOk ? 'healthy' : 'unhealthy';
      if (!smtpOk) checks.status = 'degraded';
    } catch (err) {
      checks.services.smtp = 'unhealthy';
      checks.status = 'degraded';
    }

    const statusCode = checks.status === 'healthy' ? 200 : 503;
    return reply.code(statusCode).send(checks);
  });

  // Readiness probe
  fastify.get('/health/ready', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      await redis.ping();
      return { status: 'ready' };
    } catch (err) {
      return reply.code(503).send({ status: 'not_ready', error: err.message });
    }
  });

  // Liveness probe
  fastify.get('/health/live', async (request, reply) => {
    return { status: 'alive' };
  });
}
