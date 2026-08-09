import { describe, expect, it } from 'vitest';

import { resetEspUartToRun } from '../public/esp32flash.js';
import { Transport } from '../public/vendor/esptool.js';

describe('ESP UART run reset through esptool-js Transport', () => {
  it('keeps GPIO0 released while pulsing EN at the Web Serial boundary', async () => {
    const signals: Array<Record<string, boolean>> = [];
    const port = {
      getInfo: () => ({}),
      setSignals: async (next: Record<string, boolean>) => { signals.push(next); },
    };
    const transport = new Transport(port);

    await resetEspUartToRun(transport, async () => {});

    expect(signals).toEqual([
      { dataTerminalReady: false },
      { requestToSend: true },
      { dataTerminalReady: false },
      { requestToSend: false },
      { dataTerminalReady: false },
      { dataTerminalReady: false },
      { requestToSend: false },
      { dataTerminalReady: false },
    ]);
  });
});
