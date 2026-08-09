import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BoardRegistry, buildOptions, resolveOptions } from '../src/toolchain/board.js';
import { resolveEsp32BuildProfile } from '../src/toolchain/esp32.js';

const boards = BoardRegistry.fromDirectory(join(process.cwd(), 'boards'));
const classic = boards.get('esp32:esp32:esp32')!;
const c3 = boards.get('esp32:esp32:esp32c3')!;
const s3 = boards.get('esp32:esp32:esp32s3')!;
const s2 = boards.get('esp32:esp32:esp32s2')!;
const c5 = boards.get('esp32:esp32:esp32c5')!;
const c6 = boards.get('esp32:esp32:esp32c6')!;
const h2 = boards.get('esp32:esp32:esp32h2')!;
const p4 = boards.get('esp32:esp32:esp32p4')!;

describe('ESP32 and ESP32-C3 board profiles', () => {
  it('uses the browser-compatible DIO/40 MHz C3 defaults', () => {
    const { options, errors } = resolveOptions(c3, {});
    expect(errors).toEqual([]);
    expect(options).toMatchObject({ flash_mode: 'dio', flash_freq: '40m' });

    expect(resolveEsp32BuildProfile(c3, options)).toMatchObject({
      flashMode: 'dio',
      flashFreq: '40m',
      imageFreq: '40m',
      boot: 'dio',
      bootFreq: '40m',
    });
  });

  it('maps classic ESP32 PSRAM, core selection, and 16 MB profile to official compiler inputs', () => {
    const { options, errors } = resolveOptions(classic, {
      psram: 'enabled',
      flash_mode: 'qio',
      flash_freq: '80m',
      flash_size: '16MB',
      partition_scheme: 'app3M_fat9M_16MB',
      cpu_freq: '26000000L',
      loop_core: '0',
      event_core: '0',
      debug_level: 'verbose',
    });
    expect(errors).toEqual([]);

    const profile = resolveEsp32BuildProfile(classic, options);
    expect(profile).toMatchObject({
      fCpu: '26000000L',
      flashMode: 'dio',
      flashFreq: '80m',
      flashSize: '16MB',
      boot: 'qio',
      bootFreq: '80m',
      partitions: 'app3M_fat9M_16MB',
      maxFlash: 3_145_728,
    });
    expect(profile.defines).toEqual(expect.arrayContaining([
      'BOARD_HAS_PSRAM',
      'ARDUINO_RUNNING_CORE=0',
      'ARDUINO_EVENT_RUNNING_CORE=0',
      'CORE_DEBUG_LEVEL=5',
    ]));
    expect(profile.compilerFlags).toEqual(expect.arrayContaining([
      '-mfix-esp32-psram-cache-issue',
      '-mfix-esp32-psram-cache-strategy=memw',
    ]));
  });

  it('maps ESP32-C3 USB CDC and 8 MB settings into the compiler profile', () => {
    const { options, errors } = resolveOptions(c3, {
      flash_mode: 'qio',
      flash_freq: '40m',
      flash_size: '8MB',
      partition_scheme: 'default_8MB',
      cpu_freq: '10000000L',
      usb_cdc_on_boot: 'enabled',
      debug_level: 'debug',
    });
    expect(errors).toEqual([]);

    const profile = resolveEsp32BuildProfile(c3, options);
    expect(profile).toMatchObject({
      fCpu: '10000000L',
      flashMode: 'dio',
      flashFreq: '40m',
      flashSize: '8MB',
      boot: 'qio',
      bootFreq: '40m',
      partitions: 'default_8MB',
      maxFlash: 3_342_336,
    });
    expect(profile.defines).toEqual(expect.arrayContaining([
      'ARDUINO_USB_MODE=1',
      'ARDUINO_USB_CDC_ON_BOOT=1',
      'CORE_DEBUG_LEVEL=4',
    ]));
  });

  it('rejects a large partition when the selected flash cannot hold it', () => {
    expect(resolveOptions(classic, { partition_scheme: 'fatflash' }).errors).not.toEqual([]);
    expect(resolveOptions(c3, { partition_scheme: 'default_8MB' }).errors).not.toEqual([]);
  });

  it('keeps upload-only choices out of the compiler and cache identity', () => {
    const { options, errors } = resolveOptions(classic, {
      upload_speed: '115200',
      erase_flash: 'enabled',
    });
    expect(errors).toEqual([]);
    expect(buildOptions(classic, options)).not.toHaveProperty('upload_speed');
    expect(buildOptions(classic, options)).not.toHaveProperty('erase_flash');
  });
});

describe('ESP32-S3 board profile', () => {
  it('maps the default upstream QIO menu profile to the real esptool and SDK values', () => {
    const { options, errors } = resolveOptions(s3);
    expect(errors).toEqual([]);

    const profile = resolveEsp32BuildProfile(s3, options);
    expect(profile).toMatchObject({
      flashMode: 'dio',
      flashFreq: '80m',
      boot: 'qio',
      bootFreq: '80m',
      psramType: 'qspi',
      partitions: 'default',
      maxFlash: 1_310_720,
    });
    expect(profile.defines).toEqual(expect.arrayContaining([
      'ARDUINO_RUNNING_CORE=1',
      'ARDUINO_EVENT_RUNNING_CORE=1',
      'ARDUINO_USB_MODE=1',
      'ARDUINO_USB_CDC_ON_BOOT=0',
      'ARDUINO_USB_MSC_ON_BOOT=0',
      'ARDUINO_USB_DFU_ON_BOOT=0',
      'CORE_DEBUG_LEVEL=0',
    ]));
  });

  it('rejects impossible OPI and USB combinations before a worker is queued', () => {
    expect(resolveOptions(s3, { flash_mode: 'opi' }).errors).not.toEqual([]);
    expect(resolveOptions(s3, { usb_msc_on_boot: 'enabled' }).errors).not.toEqual([]);
    expect(resolveOptions(s3, { usb_dfu_on_boot: 'enabled' }).errors).not.toEqual([]);
  });

  it('uses OPI PSRAM and TinyUSB options in the compiler profile', () => {
    const { options, errors } = resolveOptions(s3, {
      psram: 'opi',
      flash_mode: 'opi',
      usb_mode: 'tinyusb',
      usb_cdc_on_boot: 'enabled',
      usb_msc_on_boot: 'enabled',
      usb_dfu_on_boot: 'enabled',
      loop_core: '0',
      event_core: '0',
      debug_level: 'verbose',
    });
    expect(errors).toEqual([]);

    const profile = resolveEsp32BuildProfile(s3, options);
    expect(profile).toMatchObject({
      flashMode: 'dout',
      boot: 'opi',
      bootFreq: '80m',
      psramType: 'opi',
    });
    expect(profile.defines).toEqual(expect.arrayContaining([
      'BOARD_HAS_PSRAM',
      'ARDUINO_USB_MODE=0',
      'ARDUINO_USB_CDC_ON_BOOT=1',
      'ARDUINO_USB_MSC_ON_BOOT=1',
      'ARDUINO_USB_DFU_ON_BOOT=1',
      'ARDUINO_RUNNING_CORE=0',
      'ARDUINO_EVENT_RUNNING_CORE=0',
      'CORE_DEBUG_LEVEL=5',
    ]));
  });

  it('maps only trusted 32 MB partition choices to their actual CSV and app capacity', () => {
    const { options, errors } = resolveOptions(s3, {
      flash_size: '32MB',
      partition_scheme: 'app13M_data7M_32MB',
    });
    expect(errors).toEqual([]);
    expect(resolveEsp32BuildProfile(s3, options)).toMatchObject({
      flashSize: '32MB',
      partitions: 'default_32MB',
      maxFlash: 13_107_200,
    });

    expect(resolveOptions(s3, { partition_scheme: 'app13M_data7M_32MB' }).errors).not.toEqual([]);
  });
});

describe('ESP32 image frequency profiles', () => {
  it('keeps ESP32-H2 flash clock and image-header clock distinct', () => {
    const { options, errors } = resolveOptions(h2, { flash_freq: '16m' });
    expect(errors).toEqual([]);
    expect(resolveEsp32BuildProfile(h2, options)).toMatchObject({
      flashFreq: '16m',
      imageFreq: '12m',
      bootFreq: '16m',
    });
  });
});

describe('Additional ESP32 family board profiles', () => {
  it('maps ESP32-S2 USB device and PSRAM selections into real core defines', () => {
    const { options, errors } = resolveOptions(s2, {
      psram: 'enabled',
      flash_mode: 'dio',
      flash_freq: '40m',
      flash_size: '8MB',
      partition_scheme: 'default_8MB',
      cpu_freq: '160000000L',
      usb_cdc_on_boot: 'enabled',
      usb_msc_on_boot: 'enabled',
      usb_dfu_on_boot: 'enabled',
      debug_level: 'info',
    });
    expect(errors).toEqual([]);

    const profile = resolveEsp32BuildProfile(s2, options);
    expect(profile).toMatchObject({
      fCpu: '160000000L',
      flashMode: 'dio',
      flashFreq: '40m',
      imageFreq: '40m',
      flashSize: '8MB',
      boot: 'dio',
      bootFreq: '40m',
      partitions: 'default_8MB',
      maxFlash: 3_342_336,
    });
    expect(profile.defines).toEqual(expect.arrayContaining([
      'BOARD_HAS_PSRAM',
      'ARDUINO_USB_MODE=0',
      'ARDUINO_USB_CDC_ON_BOOT=1',
      'ARDUINO_USB_MSC_ON_BOOT=1',
      'ARDUINO_USB_DFU_ON_BOOT=1',
      'CORE_DEBUG_LEVEL=3',
    ]));
  });

  it('maps ESP32-C5 and ESP32-C6 RISC-V profiles to official build inputs', () => {
    const c5Resolved = resolveOptions(c5, {
      psram: 'enabled',
      flash_size: '16MB',
      partition_scheme: 'app3M_fat9M_16MB',
      cpu_freq: '120000000L',
      usb_cdc_on_boot: 'enabled',
      debug_level: 'verbose',
    });
    expect(c5Resolved.errors).toEqual([]);
    expect(resolveEsp32BuildProfile(c5, c5Resolved.options)).toMatchObject({
      fCpu: '120000000L',
      flashSize: '16MB',
      partitions: 'app3M_fat9M_16MB',
      maxFlash: 3_145_728,
    });
    expect(resolveEsp32BuildProfile(c5, c5Resolved.options).defines).toEqual(expect.arrayContaining([
      'BOARD_HAS_PSRAM',
      'ARDUINO_USB_MODE=1',
      'ARDUINO_USB_CDC_ON_BOOT=1',
      'CORE_DEBUG_LEVEL=5',
    ]));

    const c6Resolved = resolveOptions(c6, {
      flash_freq: '40m',
      flash_size: '8MB',
      partition_scheme: 'rainmaker_8MB',
      cpu_freq: '120000000L',
      usb_cdc_on_boot: 'enabled',
      debug_level: 'debug',
    });
    expect(c6Resolved.errors).toEqual([]);
    expect(resolveEsp32BuildProfile(c6, c6Resolved.options)).toMatchObject({
      fCpu: '120000000L',
      flashFreq: '40m',
      imageFreq: '40m',
      flashSize: '8MB',
      partitions: 'rainmaker_8MB',
      maxFlash: 4_104_192,
    });
  });

  it('maps ESP32-P4 ChipVariant to its matching SDK family and CPU clock', () => {
    const early = resolveOptions(p4, {
      chip_variant: 'prev3',
      psram: 'enabled',
      usb_mode: 'tinyusb',
      usb_cdc_on_boot: 'enabled',
      usb_msc_on_boot: 'enabled',
      usb_dfu_on_boot: 'enabled',
      flash_freq: '40m',
      flash_size: '32MB',
      partition_scheme: 'app13M_data7M_32MB',
      debug_level: 'info',
    });
    expect(early.errors).toEqual([]);
    expect(resolveEsp32BuildProfile(p4, early.options)).toMatchObject({
      sdkTarget: 'esp32p4_es',
      fCpu: '360000000L',
      flashFreq: '40m',
      imageFreq: '40m',
      bootFreq: '40m',
      flashSize: '32MB',
      partitions: 'default_32MB',
      maxFlash: 13_107_200,
    });
    expect(resolveEsp32BuildProfile(p4, early.options).defines).toEqual(expect.arrayContaining([
      'BOARD_HAS_PSRAM',
      'ARDUINO_USB_MODE=0',
      'ARDUINO_USB_CDC_ON_BOOT=1',
      'ARDUINO_USB_MSC_ON_BOOT=1',
      'ARDUINO_USB_DFU_ON_BOOT=1',
      'CORE_DEBUG_LEVEL=3',
    ]));

    const postV3 = resolveOptions(p4, { chip_variant: 'postv3' });
    expect(postV3.errors).toEqual([]);
    expect(resolveEsp32BuildProfile(p4, postV3.options)).toMatchObject({
      sdkTarget: 'esp32p4',
      fCpu: '400000000L',
      boot: 'qio',
    });
    expect(resolveOptions(p4, {
      usb_mode: 'hwcdc',
      usb_msc_on_boot: 'enabled',
    }).errors).not.toEqual([]);

    const twoMb = resolveOptions(p4, { flash_size: '2MB', partition_scheme: 'minimal' });
    expect(twoMb.errors).toEqual([]);
    expect(resolveEsp32BuildProfile(p4, twoMb.options)).toMatchObject({
      flashSize: '2MB',
      partitions: 'minimal',
      maxFlash: 1_310_720,
    });
    expect(resolveOptions(p4, { flash_size: '2MB' }).errors).not.toEqual([]);
  });
});
