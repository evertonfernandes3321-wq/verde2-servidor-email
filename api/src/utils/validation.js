// Schemas de validação reutilizáveis

// Email validation
export const emailSchema = {
  type: 'string',
  format: 'email',
  maxLength: 254,
};

// UUID validation
export const uuidSchema = {
  type: 'string',
  format: 'uuid',
};

// Pagination
export const paginationSchema = {
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
};

// Date range
export const dateRangeSchema = {
  type: 'object',
  properties: {
    from_date: { type: 'string', format: 'date' },
    to_date: { type: 'string', format: 'date' },
  },
};

// Send email request
export const sendEmailSchema = {
  type: 'object',
  required: ['to'],
  additionalProperties: false,
  properties: {
    to: emailSchema,
    template: { type: 'string', maxLength: 100 },
    templateId: uuidSchema,
    variables: { type: 'object' },
    from: { type: 'string', format: 'email', maxLength: 254 },
    fromName: { type: 'string', maxLength: 100 },
    replyTo: { type: 'string', format: 'email', maxLength: 254 },
    priority: { type: 'integer', minimum: 1, maximum: 10 },
    metadata: { type: 'object' },
  },
};

// Send raw email request
export const sendRawEmailSchema = {
  type: 'object',
  required: ['to', 'subject'],
  additionalProperties: false,
  properties: {
    to: emailSchema,
    subject: { type: 'string', minLength: 1, maxLength: 500 },
    html: { type: 'string', maxLength: 1048576 }, // 1MB
    text: { type: 'string', maxLength: 1048576 },
    from: { type: 'string', format: 'email', maxLength: 254 },
    fromName: { type: 'string', maxLength: 100 },
    replyTo: { type: 'string', format: 'email', maxLength: 254 },
    priority: { type: 'integer', minimum: 1, maximum: 10 },
    metadata: { type: 'object' },
  },
};

// Create template
export const createTemplateSchema = {
  type: 'object',
  required: ['slug', 'subject'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    subject: { type: 'string', minLength: 1, maxLength: 500 },
    body_html: { type: 'string', maxLength: 1048576 },
    body_text: { type: 'string', maxLength: 1048576 },
    from_name: { type: 'string', maxLength: 100 },
    from_email: { type: 'string', format: 'email', maxLength: 254 },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', maxLength: 100 },
          required: { type: 'boolean' },
          default_value: { type: 'string', maxLength: 500 },
          validation_regex: { type: 'string', maxLength: 500 },
        },
      },
    },
  },
};

// Update template
export const updateTemplateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    subject: { type: 'string', minLength: 1, maxLength: 500 },
    body_html: { type: 'string', maxLength: 1048576 },
    body_text: { type: 'string', maxLength: 1048576 },
    from_name: { type: 'string', maxLength: 100 },
    from_email: { type: 'string', format: 'email', maxLength: 254 },
    is_active: { type: 'boolean' },
  },
};

// Create API key
export const createApiKeySchema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 500 },
    rate_limit: { type: 'integer', minimum: 10, maximum: 10000, default: 100 },
    daily_limit: { type: 'integer', minimum: 100 },
    expires_at: { type: 'string', format: 'date-time' },
  },
};

// Create tenant
export const createTenantSchema = {
  type: 'object',
  required: ['slug', 'name'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[a-z0-9-]+$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    domain: { type: 'string', maxLength: 253 },
    plan: { type: 'string', enum: ['free', 'starter', 'professional', 'enterprise'], default: 'free' },
  },
};

// Webhook
export const createWebhookSchema = {
  type: 'object',
  required: ['url', 'events'],
  additionalProperties: false,
  properties: {
    url: { type: 'string', format: 'uri', maxLength: 2048 },
    events: {
      type: 'array',
      items: { type: 'string', enum: ['send', 'delivered', 'bounced', 'complained', 'opened', 'clicked'] },
      minItems: 1,
    },
  },
};
