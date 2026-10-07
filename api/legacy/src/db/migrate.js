import { pool, query } from './postgres.js';
import { log } from '../utils/logger.js';

const migrations = [
  // Migration 001: Criar tabelas iniciais
  `
  -- Tabela de API Keys
  CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    rate_limit INTEGER DEFAULT 100,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );

  -- Tabela de templates
  CREATE TABLE IF NOT EXISTS templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    body_html TEXT,
    body_text TEXT,
    from_name TEXT,
    from_email TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );

  -- Tabela de variáveis de template
  CREATE TABLE IF NOT EXISTS template_variables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    required BOOLEAN DEFAULT false,
    default_value TEXT,
    UNIQUE(template_id, name)
  );

  -- Tabela de logs de email
  CREATE TABLE IF NOT EXISTS email_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    api_key_id UUID REFERENCES api_keys(id),
    template_id UUID REFERENCES templates(id),
    to_email TEXT NOT NULL,
    from_email TEXT,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error_message TEXT,
    smtp_response TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    sent_at TIMESTAMP WITH TIME ZONE
  );

  -- Tabela de métricas agregadas por dia
  CREATE TABLE IF NOT EXISTS daily_stats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date DATE NOT NULL UNIQUE,
    total_sent INTEGER DEFAULT 0,
    total_failed INTEGER DEFAULT 0,
    total_pending INTEGER DEFAULT 0,
    unique_recipients INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );

  -- Criar índices
  CREATE INDEX IF NOT EXISTS idx_email_logs_created_at ON email_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_email_logs_status ON email_logs(status);
  CREATE INDEX IF NOT EXISTS idx_email_logs_to_email ON email_logs(to_email);
  CREATE INDEX IF NOT EXISTS idx_templates_slug ON templates(slug);
  `,
];

async function runMigrations() {
  log.info('Iniciando migrations...');

  // Criar tabela de migrations se não existir
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);

  for (let i = 0; i < migrations.length; i++) {
    const migrationName = `00${i + 1}_initial_schema`;

    // Verificar se migration já foi aplicada
    const result = await query(
      'SELECT 1 FROM _migrations WHERE name = $1',
      [migrationName]
    );

    if (result.rows.length === 0) {
      log.info({ migration: migrationName }, 'Aplicando migration');
      await query(migrations[i]);
      await query('INSERT INTO _migrations (name) VALUES ($1)', [migrationName]);
      log.info({ migration: migrationName }, 'Migration aplicada com sucesso');
    }
  }

  log.info('Migrations finalizadas');
}

runMigrations()
  .then(() => {
    log.info('Banco de dados migrado com sucesso');
    process.exit(0);
  })
  .catch((err) => {
    log.error({ err }, 'Erro ao executar migrations');
    process.exit(1);
  });
