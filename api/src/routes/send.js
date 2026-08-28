import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/postgres.js';
import { addEmailJob } from '../services/queue.js';
import { log } from '../utils/logger.js';
import { isValidEmail, isAllowedEmailDomain } from '../plugins/security.js';

// Schema de validação para envio de email
const sendEmailSchema = {
  body: {
    type: 'object',
    required: ['to'],
    properties: {
      to: { type: 'string', format: 'email' },
      template: { type: 'string' },
      templateId: { type: 'string', format: 'uuid' },
      variables: { type: 'object' },
      from: { type: 'string' },
      fromName: { type: 'string' },
      replyTo: { type: 'string' },
      priority: { type: 'integer', minimum: 1, maximum: 10 },
      metadata: { type: 'object' },
    },
  },
};

export async function sendRoutes(fastify) {
  // Enviar email
  fastify.post('/send', { schema: sendEmailSchema }, async (request, reply) => {
    const {
      to,
      template,
      templateId,
      variables,
      from,
      fromName,
      replyTo,
      priority,
      metadata,
    } = request.body;

    const tenantId = request.tenantId;
    const apiKeyId = request.apiKeyId;

    try {
      // Validar email do destinatário
      if (!isValidEmail(to)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Endereço de email inválido',
        });
      }

      // Verificar se o domínio é permitido para este tenant
      const allowedDomains = request.allowedEmailDomains;
      if (allowedDomains && !isAllowedEmailDomain(to, allowedDomains)) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Domínio de email não permitido',
        });
      }

      log.info({
        tenantId,
        apiKeyId,
        to,
        template: template || templateId,
      }, 'Recebida solicitação de envio de email');

      // Buscar template do tenant
      let templateRow = null;
      if (template || templateId) {
        const templateQuery = templateId
          ? 'SELECT * FROM templates WHERE id = $1 AND tenant_id = $2 AND is_active = true'
          : 'SELECT * FROM templates WHERE slug = $1 AND tenant_id = $2 AND is_active = true';

        const templateParams = templateId ? [templateId, tenantId] : [template, tenantId];
        const templateResult = await query(templateQuery, templateParams);
        templateRow = templateResult.rows[0];
      }

      // Criar registro de log no banco
      const logResult = await query(
        `INSERT INTO email_logs
          (tenant_id, api_key_id, to_email, from_email, subject, status, metadata)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id`,
        [
          tenantId,
          apiKeyId,
          to,
          from || null,
          templateRow?.subject || 'raw',
          metadata ? JSON.stringify(metadata) : null,
        ]
      );

      const logId = logResult.rows[0].id;

      // Adicionar job à fila
      const job = await addEmailJob({
        tenantId,
        to,
        templateId: templateRow?.id,
        templateSlug: template,
        variables: variables || {},
        fromEmail: from || templateRow?.from_email,
        fromName: fromName || templateRow?.from_name,
        replyTo,
        priority,
        metadata,
        logId,
      });

      log.info({
        jobId: job.id,
        to,
        logId,
        tenantId,
      }, 'Job de email adicionado à fila');

      return reply.code(202).send({
        success: true,
        message: 'Email adicionado à fila para envio',
        jobId: job.id,
        logId,
      });
    } catch (err) {
      log.error({ err, to, tenantId }, 'Erro ao enviar email');

      return reply.code(500).send({
        success: false,
        error: 'Internal Server Error',
        message: 'Erro ao processar solicitação',
      });
    }
  });

  // Enviar email RAW (sem template)
  fastify.post('/send/raw', async (request, reply) => {
    const {
      to,
      subject,
      html,
      text,
      from,
      fromName,
      replyTo,
      priority,
      metadata,
    } = request.body;

    const tenantId = request.tenantId;
    const apiKeyId = request.apiKeyId;

    if (!subject) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Subject é obrigatório para email raw',
      });
    }

    if (!isValidEmail(to)) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Endereço de email inválido',
      });
    }

    try {
      const logResult = await query(
        `INSERT INTO email_logs
          (tenant_id, api_key_id, to_email, from_email, subject, status, metadata)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id`,
        [tenantId, apiKeyId, to, from || null, subject, metadata ? JSON.stringify(metadata) : null]
      );

      const logId = logResult.rows[0].id;

      const job = await addEmailJob({
        tenantId,
        to,
        variables: { subject, html, text },
        fromEmail: from,
        fromName,
        replyTo,
        priority,
        metadata,
        logId,
      });

      return reply.code(202).send({
        success: true,
        message: 'Email adicionado à fila para envio',
        jobId: job.id,
        logId,
      });
    } catch (err) {
      log.error({ err, to, tenantId }, 'Erro ao enviar email raw');

      return reply.code(500).send({
        success: false,
        error: 'Internal Server Error',
        message: 'Erro ao processar solicitação',
      });
    }
  });
}
