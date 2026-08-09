import { preprocess } from '../../avr/v3/preprocess.js';
import { createBrowserToolchainPackLoader } from '../../avr/v3/toolchain-pack.js';
import {
  createEsp32S3WorkerActionMessageHandler,
} from '../v1/c3-runtime.js';
import { buildEsp32S3Image } from './image-builder.js';
import { loadEsp32C3Toolchain } from './c3-clang-runtime.js';
import { createEsp32BrowserActionExecutor } from './c3-compiler.js';

const DEFAULT_DEPENDENCIES = Object.freeze({
  createPackLoader: createBrowserToolchainPackLoader,
  loadToolchain: (loader) => loadEsp32C3Toolchain({
    loader,
    bundleUrl: new URL('../v5/xtensa/clang/bundle.js', import.meta.url),
  }),
  preprocess,
  buildImage: buildEsp32S3Image,
});

export function createEsp32S3V2WorkerActionMessageHandler({ dependencies = DEFAULT_DEPENDENCIES, postMessage } = {}) {
  if (typeof postMessage !== 'function') throw new TypeError('ESP32-S3 v2 Action postMessage is required');
  return createEsp32S3WorkerActionMessageHandler({
    openSession: async (request) => {
      const executor = await createEsp32BrowserActionExecutor({ init: request, dependencies });
      return {
        runAction: (action, context) => executor.execute(action, [...context.inputs.entries()].map(([path, bytes]) => ({ path, bytes }))),
        close: () => executor.close(),
      };
    },
    postMessage,
  });
}

const scope = typeof self === 'undefined' ? null : self;
if (scope?.addEventListener && scope?.postMessage) {
  const post = (message, transfer) => scope.postMessage(message, transfer);
  const actionHandler = createEsp32S3V2WorkerActionMessageHandler({ postMessage: post });
  scope.addEventListener('message', actionHandler);
}
