import { Application, Exit } from '@yowasp/runtime';
import * as resources from '../gen/llvm-resources.js';
import { instantiate } from '../gen/llvm.js';
import { parseClangDriverOutput } from './clang-driver-output.js';

export { Exit } from '@yowasp/runtime';

const llvm = new Application(resources, instantiate, 'sketchforge-esp32-xtensa-llvm');
const runLLVM = llvm.run.bind(llvm);

function subcommand(command, subcommandName) {
  return function (args = null, files = {}, options = {}) {
    if (args === null) return command(args, files, options);
    return command([subcommandName, ...args], files, options);
  };
}

function runClang(args = null, files = {}, options = {}) {
  if (args === null) return runLLVM(args, files, options);

  // An explicit -### request must expose Clang's output without interpreting it.
  if (args.includes('-###')) return runLLVM(args, files, options);
  if (
    args.includes('--version')
    || args.includes('-help')
    || args.includes('--help')
    || args.includes('--help-hidden')
  ) return runLLVM(args, files, options);

  function writeStderr(output) {
    if (options.stderr === undefined) {
      console.log(output);
    } else {
      options.stderr(new TextEncoder().encode(output));
      options.stderr(null);
    }
  }

  const generator = (function* runDriverCommands() {
    const [arg0, ...argsRest] = args;
    const outputSubarrays = [];
    function captureOutput(bytes) {
      if (bytes !== null) outputSubarrays.push(new Uint8Array(bytes));
    }

    let hash3Error;
    try {
      yield runLLVM([arg0, '-###', ...argsRest], files, {
        stdout: captureOutput,
        stderr: captureOutput,
        synchronously: options.synchronously,
      });
    } catch (error) {
      hash3Error = error;
    }

    const outputArray = new Uint8Array(
      outputSubarrays.reduce((total, bytes) => total + bytes.length, 0),
    );
    let outputLength = 0;
    for (const outputSubarray of outputSubarrays) {
      outputArray.set(outputSubarray, outputLength);
      outputLength += outputSubarray.length;
    }
    const output = new TextDecoder().decode(outputArray);

    if (hash3Error !== undefined) {
      writeStderr(output);
      throw hash3Error;
    }

    const parsed = parseClangDriverOutput(output);
    if (!parsed.valid) {
      writeStderr(output);
    } else {
      if (args.includes('-v')) writeStderr(output);
      else if (parsed.diagnostics) writeStderr(parsed.diagnostics);
      for (const parsedCommand of parsed.commands) {
        const command = [...parsedCommand];
        if (command[0] === '') command.shift();
        try {
          files = yield runLLVM(command, files, options);
        } catch (error) {
          if (error instanceof Exit) delete error.files.tmp;
          throw error;
        }
      }
    }
    delete files.tmp;
    return files;
  }());

  let promise;
  let resolvePromise;
  let rejectPromise;
  function runNext(value) {
    try {
      let done;
      do {
        ({ value, done } = generator.next(value));
      } while (!(value instanceof Promise) && !done);
      if (done) {
        if (resolvePromise) resolvePromise(value);
        else return value;
      }
      if (!promise) {
        promise = new Promise((resolve, reject) => {
          resolvePromise = resolve;
          rejectPromise = reject;
        });
      }
      value.then(
        (nextValue) => (done ? resolvePromise() : runNext(nextValue)),
        (error) => {
          try {
            ({ value, done } = generator.throw(error));
          } catch (unhandled) {
            rejectPromise(unhandled);
          }
        },
      );
    } catch (error) {
      if (rejectPromise) rejectPromise(error);
      else throw error;
    }
  }
  const maybeSynchronousReturn = runNext(null);
  return promise || maybeSynchronousReturn;
}

export { runLLVM, runClang };
export const commands = {
  addr2line: subcommand(runLLVM, 'addr2line'),
  ar: subcommand(runLLVM, 'ar'),
  'c++filt': subcommand(runLLVM, 'c++filt'),
  dwarfdump: subcommand(runLLVM, 'dwarfdump'),
  nm: subcommand(runLLVM, 'nm'),
  objcopy: subcommand(runLLVM, 'objcopy'),
  objdump: subcommand(runLLVM, 'objdump'),
  readobj: subcommand(runLLVM, 'readobj'),
  ranlib: subcommand(runLLVM, 'ranlib'),
  size: subcommand(runLLVM, 'size'),
  strip: subcommand(runLLVM, 'strip'),
  symbolizer: subcommand(runLLVM, 'symbolizer'),
  'wasm-ld': subcommand(runLLVM, 'wasm-ld'),
  clang: subcommand(runClang, 'clang'),
  'clang++': subcommand(runClang, 'clang++'),
};
export const version = VERSION;
