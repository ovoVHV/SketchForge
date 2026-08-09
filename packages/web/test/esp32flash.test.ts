import { describe, expect, it, vi } from 'vitest';

vi.mock('../public/vendor/esptool.js', () => ({
  ESPLoader: class {},
  Transport: class {},
}));

vi.mock('../public/artifacts.js', () => ({
  artifactBytes: vi.fn(),
}));

async function loadFlasher() {
  return import('../public/esp32flash.js');
}

describe('ESP post-flash reset', () => {
  it('releases GPIO0, pulses EN, and leaves both UART lines released', async () => {
    const sequence: string[] = [];
    const loader = { after: vi.fn() };
    const transport = {
      setDTR: async (state: boolean) => { sequence.push(`D${Number(state)}`); },
      setRTS: async (state: boolean) => { sequence.push(`R${Number(state)}`); },
    };
    const delay = async (ms: number) => { sequence.push(`W${ms}`); };
    const { resetEspAfterFlash } = await loadFlasher();

    await resetEspAfterFlash(loader, transport, delay);

    expect(sequence).toEqual(['D0', 'R1', 'W100', 'R0', 'W50', 'D0', 'R0']);
    expect(loader.after).not.toHaveBeenCalled();
  });

  it('still releases both UART lines when the reset sequence is interrupted', async () => {
    const sequence: string[] = [];
    const transport = {
      setDTR: async (state: boolean) => { sequence.push(`D${Number(state)}`); },
      setRTS: async (state: boolean) => { sequence.push(`R${Number(state)}`); },
    };
    const delay = async (ms: number) => {
      sequence.push(`W${ms}`);
      throw new Error('serial port closed');
    };
    const { resetEspUartToRun } = await loadFlasher();

    await expect(resetEspUartToRun(transport, delay)).rejects.toThrow('serial port closed');

    expect(sequence).toEqual(['D0', 'R1', 'W100', 'D0', 'R0']);
  });

  it('attempts RTS release even when DTR cleanup fails', async () => {
    const sequence: string[] = [];
    let dtrCalls = 0;
    const transport = {
      setDTR: async (state: boolean) => {
        sequence.push(`D${Number(state)}`);
        if (++dtrCalls === 2) throw new Error('DTR cleanup failed');
      },
      setRTS: async (state: boolean) => { sequence.push(`R${Number(state)}`); },
    };
    const { resetEspUartToRun } = await loadFlasher();

    await expect(resetEspUartToRun(transport, async () => {})).rejects.toThrow('DTR cleanup failed');

    expect(sequence).toEqual(['D0', 'R1', 'R0', 'D0', 'R0']);
  });

  it('uses the USB-OTG reset path when the chip reports native USB-OTG', async () => {
    const loader = {
      after: vi.fn(async () => {}),
      chip: { usesUsbOtg: vi.fn(async () => true) },
    };
    const transport = { setDTR: vi.fn(), setRTS: vi.fn() };
    const { resetEspAfterFlash } = await loadFlasher();

    await resetEspAfterFlash(loader, transport);

    expect(loader.chip.usesUsbOtg).toHaveBeenCalledWith(loader);
    expect(loader.after).toHaveBeenCalledWith('hard_reset', true);
    expect(transport.setDTR).not.toHaveBeenCalled();
    expect(transport.setRTS).not.toHaveBeenCalled();
  });

  it('recognizes targets that expose the legacy usingUsbOtg probe name', async () => {
    const loader = {
      after: vi.fn(async () => {}),
      chip: { usingUsbOtg: vi.fn(async () => true) },
    };
    const transport = { setDTR: vi.fn(), setRTS: vi.fn() };
    const { resetEspAfterFlash } = await loadFlasher();

    await resetEspAfterFlash(loader, transport);

    expect(loader.chip.usingUsbOtg).toHaveBeenCalledWith(loader);
    expect(loader.after).toHaveBeenCalledWith('hard_reset', true);
  });

  it('keeps native USB-JTAG on the existing esptool-js reset path', async () => {
    const loader = { after: vi.fn(async () => {}) };
    const transport = {
      getPid: () => 0x1001,
      setDTR: vi.fn(),
      setRTS: vi.fn(),
    };
    const { resetEspAfterFlash } = await loadFlasher();

    await resetEspAfterFlash(loader, transport, async () => {
      throw new Error('UART reset must not be used for USB-JTAG');
    });

    expect(loader.after).toHaveBeenCalledWith();
    expect(transport.setDTR).not.toHaveBeenCalled();
    expect(transport.setRTS).not.toHaveBeenCalled();
  });
});
