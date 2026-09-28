// Removes every container this platform created (label linuxlab.managed=true),
// from every backend instance. Development helper: never touches containers
// from other projects.
//
//   npm run containers:cleanup

import { config } from '../src/config.js';
import { createDockerRuntime } from '../src/modules/containers/index.js';

const runtime = createDockerRuntime(config.containers);

const containers = await runtime.listManaged({ allInstances: true });
if (containers.length === 0) {
  console.log('No linuxlab containers found.');
}
for (const c of containers) {
  await runtime.destroy(c.containerId);
  console.log(`Removed ${c.name}`);
}
