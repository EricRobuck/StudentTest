import { Router } from 'express';
import type { HealthResponse } from '@linuxlab/shared';
import { config } from '../config.js';
import type { ContainerRuntime } from '../modules/containers/index.js';

export function healthRouter(runtime: ContainerRuntime): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const docker = await runtime.status();
    const body: HealthResponse = {
      status: 'ok',
      service: config.serviceName,
      version: config.version,
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      docker: {
        available: docker.available,
        imagePresent: docker.imagePresent,
        message: docker.message,
      },
    };
    res.json(body);
  });

  return router;
}
