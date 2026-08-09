export const WORKER_POOLS = ['avr', 'esp32-xtensa', 'esp32-riscv'] as const;

export type WorkerPool = (typeof WORKER_POOLS)[number];
