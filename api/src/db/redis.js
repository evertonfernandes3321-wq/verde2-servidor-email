import Redis from "ioredis";

// Creation is lazy: imports and unit tests never open a connection.
export function createRedis(config) {
  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  connection.on("error", () => console.error("redis_connection_error"));
  return connection;
}
