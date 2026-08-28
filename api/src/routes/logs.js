import { query } from '../db/postgres.js';
import { log } from '../utils/logger.js';

export async function logRoutes(fastify) {
  // Listar logs com paginação
  fastify.get('/logs', async (request, reply) => {
    const { page = 1, limit = 50, status, to, from_date, to_date, template_id } = request.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    try {
      let whereClause = '1=1';
      const values = [];
      let paramIndex = 1;

      if (status) {
        whereClause += ` AND el.status = $${paramIndex++}`;
        values.push(status);
      }

      if (to) {
        whereClause += ` AND el.to_email ILIKE $${paramIndex++}`;
        values.push(`%${to}%`);
      }

      if (template_id) {
        whereClause += ` AND el.template_id = $${paramIndex++}`;
        values.push(template_id);
      }

      if (from_date) {
        whereClause += ` AND el.created_at >= $${paramIndex++}`;
        values.push(from_date);
      }

      if (to_date) {
        whereClause += ` AND el.created_at <= $${paramIndex++}`;
        values.push(to_date);
      }

      // Contar total
      const countResult = await query(
        `SELECT COUNT(*) as total FROM email_logs el WHERE ${whereClause}`,
        values
      );

      // Buscar logs
      const result = await query(
        `SELECT el.*, t.slug as template_slug
         FROM email_logs el
         LEFT JOIN templates t ON el.template_id = t.id
         WHERE ${whereClause}
         ORDER BY el.created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        [...values, limitNum, offset]
      );

      const total = parseInt(countResult.rows[0].total, 10);
      const totalPages = Math.ceil(total / limitNum);

      return {
        data: result.rows,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages,
        },
      };
    } catch (err) {
      log.error({ err }, 'Erro ao listar logs');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Obter log específico
  fastify.get('/logs/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      const result = await query(
        `SELECT el.*, t.slug as template_slug, t.subject as template_subject
         FROM email_logs el
         LEFT JOIN templates t ON el.template_id = t.id
         WHERE el.id = $1`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Log não encontrado' });
      }

      return result.rows[0];
    } catch (err) {
      log.error({ err, id }, 'Erro ao buscar log');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Estatísticas rápidas de um período
  fastify.get('/logs/summary', async (request, reply) => {
    const { days = 7 } = request.query;
    const daysNum = Math.min(90, Math.max(1, parseInt(days, 10)));

    try {
      const result = await query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE status = 'sent') as sent,
           COUNT(*) FILTER (WHERE status = 'failed') as failed,
           COUNT(*) FILTER (WHERE status = 'pending') as pending,
           COUNT(DISTINCT to_email) as unique_recipients
         FROM email_logs
         WHERE created_at >= NOW() - INTERVAL '${daysNum} days'`
      );

      const row = result.rows[0];

      return {
        period_days: daysNum,
        total: parseInt(row.total, 10),
        sent: parseInt(row.sent, 10),
        failed: parseInt(row.failed, 10),
        pending: parseInt(row.pending, 10),
        unique_recipients: parseInt(row.unique_recipients, 10),
        success_rate: row.total > 0 ? ((row.sent / row.total) * 100).toFixed(2) : 0,
      };
    } catch (err) {
      log.error({ err }, 'Erro ao buscar resumo de logs');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });
}
