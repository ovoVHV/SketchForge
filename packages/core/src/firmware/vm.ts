export const CK_VM_PROGRAM_CAPACITY = 256;

export const CK_VM_OPCODE = Object.freeze({
  HALT: 0,
  PIN_MODE: 1,
  DIGITAL_WRITE: 2,
  DELAY_MS: 3,
  SERIAL_PRINT: 4,
  DIGITAL_READ: 5,
  ANALOG_READ: 6,
  LOAD: 7,
  ADD: 8,
  JMP: 9,
  JMP_IF_ZERO: 10,
});

export type VmInstruction =
  | { op: 'label'; name: string }
  | { op: 'halt' }
  | { op: 'pinMode'; pin: number; mode: number }
  | { op: 'digitalWrite'; pin: number; value: number }
  | { op: 'delayMs'; milliseconds: number }
  | { op: 'serialPrint'; register: number }
  | { op: 'digitalRead'; pin: number; register: number }
  | { op: 'analogRead'; pin: number; register: number }
  | { op: 'load'; register: number; value: number }
  | { op: 'add'; destination: number; source: number }
  | { op: 'jump'; target: string }
  | { op: 'jumpIfZero'; register: number; target: string };

export interface VmProgram {
  bytes: Uint8Array;
  labels: Readonly<Record<string, number>>;
}

const SAFE_LABEL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function u8(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) throw new RangeError(`${label} must fit in uint8`);
  return value;
}

function register(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3) throw new RangeError('VM register must be 0..3');
  return value;
}

function u16(value: number, label: string): [number, number] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`${label} must fit in uint16`);
  return [value & 0xff, value >>> 8];
}

function size(instruction: VmInstruction): number {
  switch (instruction.op) {
    case 'label': return 0;
    case 'halt': return 1;
    case 'serialPrint': return 2;
    case 'pinMode': case 'digitalWrite': case 'delayMs': case 'digitalRead': case 'analogRead': case 'add': case 'jump': return 3;
    case 'load': case 'jumpIfZero': return 4;
  }
}

export function compileVmProgram(
  instructions: readonly VmInstruction[],
  capacity = CK_VM_PROGRAM_CAPACITY,
): VmProgram {
  if (!Array.isArray(instructions) || instructions.length > 4_096
    || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 0xffff) {
    throw new TypeError('VM program input is invalid');
  }
  const labels: Record<string, number> = {};
  let offset = 0;
  for (const instruction of instructions) {
    if (instruction.op === 'label') {
      if (!SAFE_LABEL.test(instruction.name)) throw new TypeError(`invalid VM label: ${instruction.name}`);
      if (labels[instruction.name] !== undefined) throw new TypeError(`duplicate VM label: ${instruction.name}`);
      labels[instruction.name] = offset;
    } else offset += size(instruction);
    if (offset > capacity) throw new RangeError(`VM program exceeds ${capacity} bytes`);
  }
  const output: number[] = [];
  let lastOperation: VmInstruction['op'] | undefined;
  const target = (name: string): [number, number] => {
    const address = labels[name];
    if (address === undefined) throw new TypeError(`unknown VM label: ${name}`);
    return u16(address, 'VM jump target');
  };
  for (const instruction of instructions) {
    if (instruction.op !== 'label') lastOperation = instruction.op;
    switch (instruction.op) {
      case 'label': break;
      case 'halt': output.push(CK_VM_OPCODE.HALT); break;
      case 'pinMode': output.push(CK_VM_OPCODE.PIN_MODE, u8(instruction.pin, 'pin'), u8(instruction.mode, 'pin mode')); break;
      case 'digitalWrite': output.push(CK_VM_OPCODE.DIGITAL_WRITE, u8(instruction.pin, 'pin'), u8(instruction.value, 'digital value')); break;
      case 'delayMs': output.push(CK_VM_OPCODE.DELAY_MS, ...u16(instruction.milliseconds, 'delay')); break;
      case 'serialPrint': output.push(CK_VM_OPCODE.SERIAL_PRINT, register(instruction.register)); break;
      case 'digitalRead': output.push(CK_VM_OPCODE.DIGITAL_READ, u8(instruction.pin, 'pin'), register(instruction.register)); break;
      case 'analogRead': output.push(CK_VM_OPCODE.ANALOG_READ, u8(instruction.pin, 'pin'), register(instruction.register)); break;
      case 'load': {
        if (!Number.isSafeInteger(instruction.value) || instruction.value < -0x8000 || instruction.value > 0xffff) {
          throw new RangeError('VM load value must fit in int16/uint16');
        }
        output.push(CK_VM_OPCODE.LOAD, register(instruction.register), ...u16(instruction.value & 0xffff, 'load value'));
        break;
      }
      case 'add': output.push(CK_VM_OPCODE.ADD, register(instruction.destination), register(instruction.source)); break;
      case 'jump': output.push(CK_VM_OPCODE.JMP, ...target(instruction.target)); break;
      case 'jumpIfZero': output.push(CK_VM_OPCODE.JMP_IF_ZERO, register(instruction.register), ...target(instruction.target)); break;
    }
  }
  if (lastOperation !== 'halt') output.push(CK_VM_OPCODE.HALT);
  if (output.length > capacity) throw new RangeError(`VM program exceeds ${capacity} bytes after HALT`);
  return { bytes: Uint8Array.from(output), labels: Object.freeze({ ...labels }) };
}
