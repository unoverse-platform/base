/**
 * Platform Module
 * Re-exports all platform functionality for node-service
 */

export { getDistributedAudioManager } from "./audioManager.js";
export { callServiceViaWorkflow, saveTokenUsageToWorkflow } from "./serviceCalls.js";
export { buildExecutionContext } from "./executionContext.js";
export { createNodeServiceAPI } from "./pluginAPI.js";
export { setRedisClient, getRedisClient } from "./redis.js";
