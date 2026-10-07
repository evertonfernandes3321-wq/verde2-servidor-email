-- ============================================
-- Schema do Banco de Dados - Verde2 Email SaaS
-- ============================================

-- Habilitar extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- Tabela de Tenants (Multi-tenancy)
-- ============================================
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    domain TEXT,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'professional', 'enterprise')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);
CREATE INDEX idx_tenants_is_active ON tenants(is_active);

-- ============================================
-- Tabela de API Keys
-- ============================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL, -- Primeiros 8 caracteres para identificação
    name TEXT NOT NULL,
    description TEXT,
    rate_limit INTEGER NOT NULL DEFAULT 100,
    daily_limit INTEGER, -- Limite diário (null = ilimitado)
    is_active BOOLEAN NOT NULL DEFAULT true,
    expires_at TIMESTAMP WITH TIME ZONE,
    last_used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX idx_api_keys_is_active ON api_keys(is_active);

-- ============================================
-- Tabela de Domínios por Tenant
-- ============================================
CREATE TABLE IF NOT EXISTS tenant_domains (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT false,
    is_default BOOLEAN NOT NULL DEFAULT false,
    dkim_selector TEXT,
    dkim_public_key TEXT,
    spf_record TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    verified_at TIMESTAMP WITH TIME ZONE,
    UNIQUE(tenant_id, domain)
);

CREATE INDEX idx_tenant_domains_tenant ON tenant_domains(tenant_id);

-- ============================================
-- Tabela de Templates
-- ============================================
CREATE TABLE IF NOT EXISTS templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_html TEXT,
    body_text TEXT,
    from_name TEXT,
    from_email TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tenant_id, slug)
);

CREATE INDEX idx_templates_tenant ON templates(tenant_id);
CREATE INDEX idx_templates_slug ON templates(slug);
CREATE INDEX idx_templates_is_active ON templates(is_active);

-- ============================================
-- Tabela de Variáveis de Template
-- ============================================
CREATE TABLE IF NOT EXISTS template_variables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    required BOOLEAN NOT NULL DEFAULT false,
    default_value TEXT,
    validation_regex TEXT,
    UNIQUE(template_id, name)
);

CREATE INDEX idx_template_variables_template ON template_variables(template_id);

-- ============================================
-- Tabela de Logs de Email
-- ============================================
CREATE TABLE IF NOT EXISTS email_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    api_key_id UUID REFERENCES api_keys(id),
    template_id UUID REFERENCES templates(id),
    to_email TEXT NOT NULL,
    from_email TEXT,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'bounced', 'complained')),
    error_code TEXT,
    error_message TEXT,
    smtp_response TEXT,
    message_id TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    sent_at TIMESTAMP WITH TIME ZONE,
    bounced_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_email_logs_tenant ON email_logs(tenant_id);
CREATE INDEX idx_email_logs_created_at ON email_logs(created_at DESC);
CREATE INDEX idx_email_logs_status ON email_logs(status);
CREATE INDEX idx_email_logs_to_email ON email_logs(to_email);
CREATE INDEX idx_email_logs_template ON email_logs(template_id);

-- ============================================
-- Tabela de Métricas Diárias por Tenant
-- ============================================
CREATE TABLE IF NOT EXISTS daily_stats (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    total_sent INTEGER NOT NULL DEFAULT 0,
    total_failed INTEGER NOT NULL DEFAULT 0,
    total_bounced INTEGER NOT NULL DEFAULT 0,
    total_complained INTEGER NOT NULL DEFAULT 0,
    unique_recipients INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tenant_id, date)
);

CREATE INDEX idx_daily_stats_tenant_date ON daily_stats(tenant_id, date DESC);

-- ============================================
-- Tabela de Webhooks
-- ============================================
CREATE TABLE IF NOT EXISTS webhooks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    events TEXT[] NOT NULL, -- Array de eventos: 'send', 'bounce', 'complaint', 'open', 'click'
    secret TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_webhooks_tenant ON webhooks(tenant_id);

-- ============================================
-- Tabela de Audit Log (Segurança)
-- ============================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    api_key_id UUID REFERENCES api_keys(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_tenant ON audit_logs(tenant_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_api_key ON audit_logs(api_key_id);

-- ============================================
-- Tabela de Migrations
-- ============================================
CREATE TABLE IF NOT EXISTS _migrations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Aplicar triggers
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_keys_updated_at BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_templates_updated_at BEFORE UPDATE ON templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_daily_stats_updated_at BEFORE UPDATE ON daily_stats
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- Função para atualizar estatísticas diárias
-- ============================================
CREATE OR REPLACE FUNCTION update_daily_email_stats()
RETURNS TRIGGER AS $$
DECLARE
    v_tenant_id UUID;
    v_date DATE;
BEGIN
    -- Determinar tenant_id
    IF TG_TABLE_NAME = 'email_logs' THEN
        v_tenant_id := NEW.tenant_id;
        v_date := NEW.created_at::DATE;
    ELSE
        RETURN NEW;
    END IF;

    -- Upsert nas estatísticas
    INSERT INTO daily_stats (tenant_id, date, total_sent, total_failed, total_bounced)
    VALUES (v_tenant_id, v_date,
        CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
        CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
        CASE WHEN NEW.status = 'bounced' THEN 1 ELSE 0 END
    )
    ON CONFLICT (tenant_id, date) DO UPDATE SET
        total_sent = daily_stats.total_sent + CASE WHEN NEW.status = 'sent' THEN 1 ELSE 0 END,
        total_failed = daily_stats.total_failed + CASE WHEN NEW.status = 'failed' THEN 1 ELSE 0 END,
        total_bounced = daily_stats.total_bounced + CASE WHEN NEW.status = 'bounced' THEN 1 ELSE 0 END,
        updated_at = NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Criar trigger para atualizar stats
CREATE TRIGGER trigger_update_daily_stats
    AFTER INSERT ON email_logs
    FOR EACH ROW
    EXECUTE FUNCTION update_daily_email_stats();

