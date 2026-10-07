import { Queue, Worker } from 'bullmq';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';
import { sendEmail, renderTemplate } from './email.js';
import { query } from '../db/postgres.js';
import { cache } from '../db/redis.js';

// Criar queue para envio de emails
export const emailQueue = new Queue('email-send', {
  connection: {
    host: config.redis.host,
    port: config.redis.port,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

// Worker para processar emails
const worker = new Worker('email-send', async (job) => {
  const { to, templateId, templateSlug, variables, fromEmail, fromName, apiKeyId, metadata } = job.data;

  log.info({ jobId: job.id, to, templateSlug }, 'Processando job de email');

  try {
    // Buscar template se fornecido
    let template = null;
    if (templateId) {
      const result = await query(
        'SELECT * FROM templates WHERE id = $1 AND is_active = true',
        [templateId]
      );
      template = result.rows[0];
    } else if (templateSlug) {
      const result = await query(
        'SELECT * FROM templates WHERE slug = $1 AND is_active = true',
        [templateSlug]
      );
      template = result.rows[0];
    }

    let subject, bodyHtml, bodyText;

    if (template) {
      const rendered = renderTemplate(template, variables);
      subject = rendered.subject;
      bodyHtml = rendered.bodyHtml;
      bodyText = rendered.bodyText;
    } else {
      // Email sem template (raw)
      subject = variables?.subject || 'Sem assunto';
      bodyHtml = variables?.html || '';
      bodyText = variables?.text || '';
    }

    // Enviar email
    const result = await sendEmail({
      to,
      subject,
      html: bodyHtml,
      text: bodyText,
      from: fromEmail,
    });

    // Atualizar log no banco
    const status = result.success ? 'sent' : 'failed';
    await query(
      `UPDATE email_logs
       SET status = $1,
           sent_at = NOW(),
           error_message = $2,
           smtp_response = $3
       WHERE id = $4`,
      [status, result.error || null, result.response || null, job.data.logId]
    );

    // Atualizar estatísticas do dia
    await updateDailyStats(status);

    // Atualizar cache de métricas
    const statsKey = 'stats:daily';
    const currentStats = await cache.get(statsKey) || { sent: 0, failed: 0 };
    if (result.success) {
      currentStats.sent++;
    } else {
      currentStats.failed++;
    }
    await cache.set(statsKey, currentStats, 86400); // 24 horas

    if (!result.success) {
      throw new Error(result.error);
    }

    return result;
  } catch (err) {
    log.error({ err, jobId: job.id }, 'Erro ao processar job de email');

    // Marcar como falha no log
    await query(
      `UPDATE email_logs SET status = 'failed', error_message = $1 WHERE id = $2`,
      [err.message, job.data.logId]
    );

    await updateDailyStats('failed');

    throw err;
  }
}, {
  connection: {
    host: config.redis.host,
    port: config.redis.port,
  },
  concurrency: 10,
});

worker.on('completed', (job) => {
  log.info({ jobId: job.id }, 'Job de email completado');
});

worker.on('failed', (job, err) => {
  log.error({ jobId: job.id, err }, 'Job de email falhou');
});

// Função para atualizar estatísticas diárias
async function updateDailyStats(status) {
  const today = new Date().toISOString().split('T')[0];

  if (status === 'sent') {
    await query(
      `INSERT INTO daily_stats (date, total_sent, updated_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (date) DO UPDATE SET
         total_sent = daily_stats.total_sent + 1,
         updated_at = NOW()`,
      [today]
    );
  } else if (status === 'failed') {
    await query(
      `INSERT INTO daily_stats (date, total_failed, updated_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (date) DO UPDATE SET
         total_failed = daily_stats.total_failed + 1,
         updated_at = NOW()`,
      [today]
    );
  }
}

// Adicionar job à fila
export async function addEmailJob(data) {
  return emailQueue.add('send', data, {
    priority: data.priority || 2,
  });
}
