import { query } from '../db/postgres.js';
import { cache } from '../db/redis.js';
import { log } from '../utils/logger.js';

export async function statsRoutes(fastify) {
  // Estatísticas gerais
  fastify.get('/stats', async (request, reply) => {
    const { days = 30 } = request.query;
    const daysNum = Math.min(365, Math.max(1, parseInt(days, 10)));

    try {
      // Tentar buscar do cache primeiro
      const cacheKey = `stats:global:${daysNum}`;
      const cached = await cache.get(cacheKey);
      if (cached) {
        return cached;
      }

      // Buscar do banco
      const result = await query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'sent') as sent,
           COUNT(*) FILTER (WHERE status = 'failed') as failed,
           COUNT(*) FILTER (WHERE status = 'pending') as pending,
           COUNT(DISTINCT to_email) as unique_recipients,
           MIN(created_at) as first_email,
           MAX(created_at) as last_email
         FROM email_logs
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'`
      );

      const row = result.rows[0];

      const stats = {
        period_days: daysNum,
        total: parseInt(row.total, 10),
        sent: parseInt(row.sent, 10),
        failed: parseInt(row.failed, 10),
        pending: parseInt(row.pending, 10),
        unique_recipients: parseInt(row.unique_recipients, 10),
        first_email: row.first_email,
        last_email: row.last_email,
        success_rate: row.total > 0 ? ((row.sent / row.total) * 100).toFixed(2) : 0,
      };

      // Armazenar em cache por 5 minutos
      await cache.set(cacheKey, stats, 300);

      return stats;
    } catch (err) {
      log.error({ err }, 'Erro ao buscar estatísticas');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Estatísticas por dia
  fastify.get('/stats/daily', async (request, reply) => {
    const { days = 30 } = request.query;
    const daysNum = Math.min(90, Math.max(1, parseInt(days, 10)));

    try {
      const result = await query(
        `SELECT
           date_trunc('day', created_at) as day,
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'sent') as sent,
           COUNT(*) FILTER (WHERE status = 'failed') as failed,
           COUNT(DISTINCT to_email) as unique_recipients
         FROM email_logs
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'
         GROUP BY date_trunc('day', created_at)
         ORDER BY day DESC`
      );

      return result.rows.map(row => ({
        day: row.day,
        total: parseInt(row.total, 10),
        sent: parseInt(row.sent, 10),
        failed: parseInt(row.failed, 10),
        unique_recipients: parseInt(row.unique_recipients, 10),
      }));
    } catch (err) {
      log.error({ err }, 'Erro ao buscar estatísticas diárias');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Estatísticas por template
  fastify.get('/stats/templates', async (request, reply) => {
    const { days = 30 } = request.query;
    const daysNum = Math.min(365, Math.max(1, parseInt(days, 10)));

    try {
      const result = await query(
        `SELECT
           t.slug,
           t.subject,
           COUNT(el.id) as total,
           COUNT(el.id) FILTER (WHERE el.status = 'sent') as sent,
           COUNT(el.id) FILTER (WHERE el.status = 'failed') as failed
         FROM templates t
         LEFT JOIN email_logs el ON t.id = el.template_id
           AND el.created_at >= NOW() - INTERVAL '${daysNum} days'
         GROUP BY t.id, t.slug, t.subject
         ORDER BY total DESC`
      );

      return result.rows.map(row => ({
        slug: row.slug,
        subject: row.subject,
        total: parseInt(row.total, 10),
        sent: parseInt(row.sent, 10),
        failed: parseInt(row.failed, 10),
        success_rate: row.total > 0 ? ((row.sent / row.total) * 100).toFixed(2) : 0,
      }));
    } catch (err) {
      log.error({ err }, 'Erro ao buscar estatísticas por template');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Estatísticas em tempo real (do Redis)
  fastify.get('/stats/realtime', async (request, reply) => {
    try {
      const statsKey = 'stats:daily';
      const currentStats = await cache.get(statsKey) || { sent: 0, failed: 0 };

      return {
        sent_today: currentStats.sent,
        failed_today: currentStats.failed,
        success_rate: (currentStats.sent + currentStats.failed) > 0
          ? ((currentStats.sent / (currentStats.sent + currentStats.failed)) * 100).toFixed(2)
          : 0,
      };
    } catch (err) {
      log.error({ err }, 'Erro ao buscar estatísticas em tempo real');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });
}
