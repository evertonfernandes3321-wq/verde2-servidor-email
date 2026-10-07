import Redis from 'ioredis';
import { config } from '../config/index.js';
import { log } from '../utils/logger.js';

export const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('connect', () => {
  log.info('Conectado ao Redis');
});

redis.on('error', (err) => {
  log.error({ err }, 'Erro na conexão Redis');
});

export const cache = {
  async get(key) {
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  },

  async set(key, value, ttlSeconds = 3600) {
    await redis.setex(key, ttlSeconds, JSON.stringify(value));
  },

  async del(key) {
    await redis.del(key);
  },

  async incr(key) {
    return redis.incr(key);
  },

  async expire(key, seconds) {
    return redis.expire(key, seconds);
  },
};
