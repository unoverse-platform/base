/**
 * Redis Client Management
 */

import { Redis } from "ioredis";
import { boot } from "../boot.js";

let redisClient: Redis | null = null;

export function setRedisClient(client: Redis): void {
  redisClient = client;
}

export function getRedisClient(): Redis | null {
  return redisClient;
}

/**
 * Initialise the runtime's shared Redis command client from env, once, at boot.
 *
 * Node execution reaches Redis through `executionContext.api.getRedisClient()`
 * (see executionContext.ts) — used e.g. by the OpenAI/ChatGPT agents to persist
 * per-conversation state (`openai:conv:*`, `previous_response_id`) so multi-turn
 * history survives across turns. Without this, getRedisClient() returns null,
 * the agents log `hasRedis=false`, and every turn starts a NEW conversation.
 *
 * This is a normal command connection — distinct from the pub/sub subscriber in
 * lifecycleBridge.ts (an ioredis connection in subscriber mode can't run GET/SETEX).
 */
export function initRuntimeRedis(): void {
  if (redisClient) return; // already initialised
  const host = process.env.REDIS_HOST;
  const port = process.env.REDIS_PORT;
  if (!host || !port) {
    console.warn(
      "[unoverse:runtime] REDIS_HOST/REDIS_PORT not configured — node runtime Redis disabled (agent multi-turn history will not persist)",
    );
    return;
  }

  const client = new Redis({
    host,
    port: parseInt(port, 10),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    retryStrategy: (times: number) => Math.min(times * 100, 3000),
  });
  client.on("error", (err: Error) => {
    console.warn(`[unoverse:runtime] Redis client error: ${err.message}`);
  });

  setRedisClient(client);
  boot.redis("connected, agent multi-turn history enabled");
}
