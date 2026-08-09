import { runAutoscaleService } from './autoscale-service.js';

await runAutoscaleService().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
