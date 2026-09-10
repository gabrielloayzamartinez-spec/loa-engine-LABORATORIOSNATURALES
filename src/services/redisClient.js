// src/services/redisClient.js
// Centralised Redis client using ioredis
import IORedis from 'ioredis';

const redis = new IORedis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined
});

export default redis;
