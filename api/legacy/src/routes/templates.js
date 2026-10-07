import { query } from '../db/postgres.js';
import { log } from '../utils/logger.js';

// Schemas de validação
const templateSchema = {
  body: {
    type: 'object',
    required: ['slug', 'subject'],
    properties: {
      slug: { type: 'string', minLength: 1, maxLength: 100 },
      subject: { type: 'string', minLength: 1, maxLength: 500 },
      body_html: { type: 'string' },
      body_text: { type: 'string' },
      from_name: { type: 'string', maxLength: 100 },
      from_email: { type: 'string', format: 'email' },
    },
  },
};

const templateUpdateSchema = {
  body: {
    type: 'object',
    properties: {
      slug: { type: 'string', minLength: 1, maxLength: 100 },
      subject: { type: 'string', minLength: 1, maxLength: 500 },
      body_html: { type: 'string' },
      body_text: { type: 'string' },
      from_name: { type: 'string', maxLength: 100 },
      from_email: { type: 'string', format: 'email' },
      is_active: { type: 'boolean' },
    },
  },
};

export async function templateRoutes(fastify) {
  // Listar todos os templates
  fastify.get('/templates', async (request, reply) => {
    try {
      const result = await query(
        `SELECT t.*,
                COALESCE(json_agg(
                  json_build_object('name', tv.name, 'required', tv.required, 'default_value', tv.default_value)
                ) FILTER (WHERE tv.id IS NOT NULL), '[]') as variables
         FROM templates t
         LEFT JOIN template_variables tv ON t.id = tv.template_id
         GROUP BY t.id
         ORDER BY t.updated_at DESC`
      );

      return result.rows;
    } catch (err) {
      log.error({ err }, 'Erro ao listar templates');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Obter template por ID
  fastify.get('/templates/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      const result = await query(
        `SELECT t.*,
                COALESCE(json_agg(
                  json_build_object('id', tv.id, 'name', tv.name, 'required', tv.required, 'default_value', tv.default_value)
                ) FILTER (WHERE tv.id IS NOT NULL), '[]') as variables
         FROM templates t
         LEFT JOIN template_variables tv ON t.id = tv.template_id
         WHERE t.id = $1
         GROUP BY t.id`,
        [id]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Template não encontrado' });
      }

      return result.rows[0];
    } catch (err) {
      log.error({ err, id }, 'Erro ao buscar template');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Obter template por slug
  fastify.get('/templates/slug/:slug', async (request, reply) => {
    const { slug } = request.params;

    try {
      const result = await query(
        `SELECT t.*,
                COALESCE(json_agg(
                  json_build_object('name', tv.name, 'required', tv.required, 'default_value', tv.default_value)
                ) FILTER (WHERE tv.id IS NOT NULL), '[]') as variables
         FROM templates t
         LEFT JOIN template_variables tv ON t.id = tv.template_id
         WHERE t.slug = $1
         GROUP BY t.id`,
        [slug]
      );

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Template não encontrado' });
      }

      return result.rows[0];
    } catch (err) {
      log.error({ err, slug }, 'Erro ao buscar template');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Criar template
  fastify.post('/templates', { schema: templateSchema }, async (request, reply) => {
    const { slug, subject, body_html, body_text, from_name, from_email, variables } = request.body;

    try {
      // Verificar se slug já existe
      const existing = await query('SELECT id FROM templates WHERE slug = $1', [slug]);
      if (existing.rows.length > 0) {
        return reply.code(409).send({ error: 'Conflict', message: 'Slug de template já existe' });
      }

      const result = await query(
        `INSERT INTO templates (slug, subject, body_html, body_text, from_name, from_email)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [slug, subject, body_html || null, body_text || null, from_name || null, from_email || null]
      );

      const template = result.rows[0];

      // Adicionar variáveis se fornecidas
      if (variables && Array.isArray(variables)) {
        for (const v of variables) {
          await query(
            `INSERT INTO template_variables (template_id, name, required, default_value)
             VALUES ($1, $2, $3, $4)`,
            [template.id, v.name, v.required || false, v.default_value || null]
          );
        }
      }

      log.info({ templateId: template.id, slug }, 'Template criado');

      return reply.code(201).send(template);
    } catch (err) {
      log.error({ err }, 'Erro ao criar template');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Atualizar template
  fastify.put('/templates/:id', { schema: templateUpdateSchema }, async (request, reply) => {
    const { id } = request.params;
    const { slug, subject, body_html, body_text, from_name, from_email, is_active } = request.body;

    try {
      // Verificar se template existe
      const existing = await query('SELECT id FROM templates WHERE id = $1', [id]);
      if (existing.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Template não encontrado' });
      }

      // Verificar se novo slug já existe (se for diferente)
      if (slug) {
        const slugExists = await query(
          'SELECT id FROM templates WHERE slug = $1 AND id != $2',
          [slug, id]
        );
        if (slugExists.rows.length > 0) {
          return reply.code(409).send({ error: 'Conflict', message: 'Slug de template já existe' });
        }
      }

      const updates = [];
      const values = [];
      let paramIndex = 1;

      if (slug !== undefined) {
        updates.push(`slug = $${paramIndex++}`);
        values.push(slug);
      }
      if (subject !== undefined) {
        updates.push(`subject = $${paramIndex++}`);
        values.push(subject);
      }
      if (body_html !== undefined) {
        updates.push(`body_html = $${paramIndex++}`);
        values.push(body_html);
      }
      if (body_text !== undefined) {
        updates.push(`body_text = $${paramIndex++}`);
        values.push(body_text);
      }
      if (from_name !== undefined) {
        updates.push(`from_name = $${paramIndex++}`);
        values.push(from_name);
      }
      if (from_email !== undefined) {
        updates.push(`from_email = $${paramIndex++}`);
        values.push(from_email);
      }
      if (is_active !== undefined) {
        updates.push(`is_active = $${paramIndex++}`);
        values.push(is_active);
      }

      if (updates.length === 0) {
        return reply.code(400).send({ error: 'Bad Request', message: 'Nenhum campo para atualizar' });
      }

      updates.push(`updated_at = NOW()`);
      values.push(id);

      const result = await query(
        `UPDATE templates SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
        values
      );

      log.info({ templateId: id }, 'Template atualizado');

      return result.rows[0];
    } catch (err) {
      log.error({ err, id }, 'Erro ao atualizar template');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Deletar template
  fastify.delete('/templates/:id', async (request, reply) => {
    const { id } = request.params;

    try {
      const result = await query('DELETE FROM templates WHERE id = $1 RETURNING id', [id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Template não encontrado' });
      }

      log.info({ templateId: id }, 'Template deletado');

      return reply.code(204).send();
    } catch (err) {
      log.error({ err, id }, 'Erro ao deletar template');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });

  // Preview template com variáveis
  fastify.post('/templates/:id/preview', async (request, reply) => {
    const { id } = request.params;
    const { variables } = request.body;

    try {
      const result = await query('SELECT * FROM templates WHERE id = $1', [id]);

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Not Found', message: 'Template não encontrado' });
      }

      const template = result.rows[0];

      // Importar função de renderização
      const { renderTemplate } = await import('../services/email.js');
      const rendered = renderTemplate(template, variables || {});

      return {
        template: {
          id: template.id,
          slug: template.slug,
        },
        rendered,
      };
    } catch (err) {
      log.error({ err, id }, 'Erro ao gerar preview');
      return reply.code(500).send({ error: 'Internal Server Error', message: err.message });
    }
  });
}
