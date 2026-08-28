import pg from 'pg';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  log.error({ err }, 'Erro no pool de conexão PostgreSQL');
});

// Query helpers
export const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  log.debug({ text, duration, rows: res.rowCount }, 'Query executada');
  return res;
};

export const getClient = async () => {
  return pool.connect();
};
