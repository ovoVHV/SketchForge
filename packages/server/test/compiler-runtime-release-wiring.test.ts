import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n');
}

describe('production compiler runtime release wiring', () => {
  it('keeps runtime cache and prebuild evidence tests in the central contract gate', () => {
    const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    const contracts = packageJson.scripts['test:ck-build-contracts'] ?? '';
    for (const test of [
      'packages/server/test/compiler-runtime-release.test.ts',
      'packages/server/test/compiler-runtime-release-wiring.test.ts',
      'packages/server/test/worker-runtime-cache.test.ts',
      'packages/server/test/prebuild-firmware-assets.test.ts',
      'packages/server/test/prebuild-featured-firmware.test.ts',
    ]) {
      expect(contracts).toContain(test);
    }
  });

  it('publishes all three build-push digests as one canonical manifest', () => {
    const workflow = read('.github/workflows/prebuild-worker-images.yml');
    expect(workflow).toContain('id: image');
    expect(workflow).toContain('IMAGE_DIGEST: ${{ steps.image.outputs.digest }}');
    expect(workflow).toContain('pattern: compiler-runtime-*');
    expect(workflow).toContain('compiler-runtime-release-cli.ts create');
    expect(workflow).toContain('--output release/compiler-runtime-release.json');
    expect(workflow).toContain('name: compiler-runtime-release');
    expect(workflow).toContain('needs: [worker, runtime-release]');
    expect(workflow).toContain('compile_release_id: ${{ steps.release.outputs.compile_release_id }}');
    expect(workflow).toContain('esp32_riscv_image_digest: ${{ steps.release.outputs.esp32_riscv_image_digest }}');
  });

  it('publishes the Gateway as an immutable deployment image', () => {
    const workflow = read('.github/workflows/prebuild-worker-images.yml');
    expect(workflow).toContain('name: Publish Gateway image');
    expect(workflow).toContain('file: docker/Dockerfile.gateway');
    expect(workflow).toContain('platforms: linux/amd64');
    expect(workflow).toContain('AF_GATEWAY_IMAGE=${image}');
    expect(workflow).toContain('name: gateway-image-release');
    expect(workflow).toContain('path: release/gateway-image.env');
    expect(workflow).toContain('needs: [worker, gateway]');
  });

  it('uses only canonical digest outputs for every downstream container', () => {
    const workflow = read('.github/workflows/prebuild-worker-images.yml');
    const downstream = workflow.slice(workflow.indexOf('  static-firmware:'));
    expect(downstream).not.toContain('GITHUB_REF_NAME');
    expect(downstream).not.toMatch(/image="ghcr\.io\/.*:\$\{tag\}"/);
    expect(downstream).toContain('image="${XTENSA_IMAGE}"');
    expect(downstream).toContain('image="${RISCV_IMAGE}"');
    expect(downstream).toContain('image="${AVR_IMAGE}"');
    expect(downstream).toContain('-e AF_COMPILE_RELEASE_ID="${COMPILE_RELEASE_ID}"');
    expect(downstream).toContain('-e AF_HOST_RUNTIME_IDENTITY="${host_runtime_identity}"');
    expect(downstream).toContain('-e AF_WORKER_IMAGE_DIGEST="${image_digest}"');
    expect(downstream).toContain('compiler-runtime-release.json:/runtime/compiler-runtime-release.json:ro');
    expect(downstream.match(/@sha256:\[a-f0-9\]\{64\}/g)?.length).toBeGreaterThanOrEqual(4);

    for (const source of [
      read('packages/server/src/prebuild-firmware-assets.ts'),
      read('packages/server/src/prebuild-featured-firmware.ts'),
    ]) {
      expect(source).toContain('schema: 2');
      expect(source).toContain('runtimeIdentities');
      expect(source).toContain('normalizeCompilerRuntimeEvidence');
      expect(source).toContain('compilerRuntimeEvidenceFromEnvironment');
    }
  });

  it('requires digest-only worker images and one read-only manifest in production Compose', () => {
    const baseCompose = read('docker/compose.distributed.yml');
    const compose = read('docker/compose.distributed.production.yml');
    expect(baseCompose).toContain('NODE_ENV: development');
    expect(baseCompose).not.toContain('NODE_ENV: production');
    expect(compose).toContain('NODE_ENV: production');
    expect(compose.match(/image: "\$\{AF_GATEWAY_IMAGE:\?/g)).toHaveLength(2);
    for (const variable of [
      'AF_WORKER_AVR_IMAGE',
      'AF_WORKER_ESP32_XTENSA_IMAGE',
      'AF_WORKER_ESP32_RISCV_IMAGE',
    ]) {
      expect(compose).toContain(`image: "\${${variable}:?`);
    }
    expect(compose.match(/AF_HOST_RUNTIME_IDENTITY:/g)).toHaveLength(3);
    expect(compose).toContain('AF_COMPILE_RELEASE_ID: "${AF_COMPILE_RELEASE_ID:?');
    expect(compose).toContain('target: /run/arduinofast/compiler-runtime-release.json');
    expect(compose).toContain('read_only: true');
    expect(compose).not.toMatch(/worker-(?:avr|esp32-(?:xtensa|riscv)):[A-Za-z0-9]/);
    for (const dockerfile of [
      'docker/Dockerfile.gateway',
      'docker/Dockerfile.worker-avr',
      'docker/Dockerfile.worker-esp32',
    ]) {
      expect(read(dockerfile)).toContain('/run/arduinofast');
    }
  });

  it('keeps the small-host deployment browser-first and Worker-free', () => {
    const gateway = read('packages/server/src/gateway.ts');
    const compose = read('docker/compose.gateway.production.yml');
    const envExample = read('docker/browser-only.env.example');
    const originsExample = read('docker/toolchain-origins.example.js');
    const prefetch = read('docker/prefetch-gateway-only.sh');
    const deploy = read('docker/deploy-browser-only.sh');

    expect(gateway).toContain("const BROWSER_ONLY_MODE = process.env.AF_BROWSER_ONLY === '1';");
    expect(gateway).toContain("error: 'server_compile_disabled'");
    expect(gateway).toContain("mode: BROWSER_ONLY_MODE ? 'browser-only' : 'distributed-gateway'");
    expect(gateway).toContain('serverCompile: !BROWSER_ONLY_MODE');

    expect(compose).toContain('AF_BROWSER_ONLY: "1"');
    expect(compose).toContain('AF_COMPILE_RELEASE_ID: unverified-local');
    expect(compose).toContain('image: "${AF_GATEWAY_IMAGE:?AF_GATEWAY_IMAGE must be repository@sha256:digest}"');
    expect(compose).toContain('source: "${AF_TOOLCHAIN_ORIGINS_FILE:?AF_TOOLCHAIN_ORIGINS_FILE is required}"');
    expect(compose).toContain('target: /app/packages/web/public/toolchain-origins.js');
    expect(compose).toContain('read_only: true');
    expect(compose).not.toMatch(/^\s{2}(?:autoscaler|worker-[a-z0-9-]+):/m);

    expect(envExample).toContain('AF_TOOLCHAIN_ORIGINS_FILE=/srv/arduinofast/toolchain-origins.js');
    expect(originsExample).toContain('__ARDUINOFAST_TOOLCHAIN_ORIGINS__');
    expect(prefetch).toContain('docker pull --platform linux/amd64 redis:7.4.2-alpine');
    expect(prefetch).toContain('docker pull --platform linux/amd64 "$GATEWAY_IMAGE"');
    expect(prefetch).not.toContain('docker compose');
    expect(prefetch).not.toContain('runsc');
    expect(prefetch).not.toContain('compiler-runtime-release');
    expect(deploy).toContain('docker compose version');
    expect(deploy).toContain('docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --no-build --pull never --no-recreate');
    expect(deploy).toContain('AF_BROWSER_ONLY');
    expect(deploy).toContain('EXPECTED_ORIGINS_FILE');
    expect(deploy).not.toContain('runsc');
    expect(deploy).not.toContain('verify-distributed.mjs');
    expect(deploy).not.toContain('compiler-runtime-release');
  });

  it('derives deployment variables from the canonical parser and rejects tag references', () => {
    const deploy = read('docker/deploy-distributed.sh');
    const inspect = deploy.indexOf('compiler-runtime-release-cli.js inspect');
    const compose = deploy.indexOf('docker compose -p');
    expect(inspect).toBeGreaterThan(0);
    expect(inspect).toBeLessThan(compose);
    expect(deploy).toContain('GATEWAY_IMAGE="${AF_GATEWAY_IMAGE:-}"');
    expect(deploy).toContain('AF_GATEWAY_IMAGE must name the immutable Gateway');
    expect(deploy).toContain('Production image must use repository@sha256:digest');
    expect(deploy).toContain('require_digest_image "$GATEWAY_IMAGE"');
    expect(deploy).toContain('docker compose version');
    expect(deploy).toContain('linux/amd64|linux/x86_64');
    expect(deploy).toContain('require_digest_image "$AF_WORKER_AVR_IMAGE"');
    expect(deploy).toContain('EXPECTED_GATEWAY_IMAGE="$GATEWAY_IMAGE"');
    expect(deploy).toContain('rendered Gateway/Autoscaler digest contract failed');
    expect(deploy).toContain('rendered worker digest/identity contract failed');
    expect(deploy).not.toContain("GATEWAY_IMAGE='arduinofast/gateway:production-v2'");
    expect(deploy).not.toContain("require_image 'arduinofast/worker-avr:production-v2'");
  });

  it('documents the complete digest-only production input contract', () => {
    const example = read('docker/deploy.production.env.example');
    const prefetch = read('docker/prefetch-distributed-images.sh');
    const readme = read('README.md');
    expect(example).toContain('AF_GATEWAY_IMAGE=ghcr.io/your-org/arduinofast-gateway@sha256:');
    expect(example).toContain('AF_COMPILER_RUNTIME_RELEASE_FILE=/srv/arduinofast/compiler-runtime-release.json');
    expect(example).not.toMatch(/^AF_ACK_HOST_ISOLATION=/m);
    expect(example).not.toMatch(/^AF_ACK_DUAL_ESP32=/m);
    expect(readme).toContain('gateway-image-release/gateway-image.env');
    expect(readme).toContain('compiler-runtime-release/compiler-runtime-release.json');
    expect(readme).toContain('包装器本身不会 build 或 pull');
    expect(readme).toContain('bash docker/prefetch-distributed-images.sh');
    expect(prefetch).toContain('compiler-runtime-release-cli.js inspect');
    expect(prefetch).toContain('docker pull --platform linux/amd64 "$GATEWAY_IMAGE"');
    expect(prefetch).toContain('docker pull --platform linux/amd64 "$image"');
    expect(prefetch).toContain('linux/amd64|linux/x86_64');
    expect(prefetch).not.toContain('docker compose');
    expect(prefetch).not.toMatch(/docker (?:build|run .*gateway\.js)/);
  });

  it('checks release and host identity before a worker advertises or consumes jobs', () => {
    const gateway = read('packages/server/src/gateway.ts');
    const worker = read('packages/server/src/worker.ts');
    const capabilities = read('packages/server/src/capabilities.ts');
    const queue = read('packages/server/src/distributed-queue.ts');
    const prewarm = read('packages/server/src/prewarm-cache-entrypoint.ts');

    expect(gateway).toContain('IS_PRODUCTION && !BROWSER_ONLY_MODE');
    expect(gateway).toContain('worker.hostRuntimeIdentity === expectedRuntimeIdentity');
    expect(worker.indexOf('workerHostRuntimeIdentity(runtimeConfiguration, pool, process.env)'))
      .toBeLessThan(worker.indexOf("createRedisConnection('worker')"));
    expect(worker).toContain('job.data.compileReleaseId !== runtimeConfiguration.releaseId');
    expect(worker).toContain('job.data.hostRuntimeIdentity !== hostRuntimeIdentity');
    expect(capabilities).toContain('capability.hostRuntimeIdentity === runtimeConfiguration.runtimes[');
    expect(queue).toContain('compileReleaseId: this.namespace.releaseId');
    expect(queue).toContain('hostRuntimeIdentity: this.hostRuntimeIdentities[pool]');
    expect(queue).toContain('assertRuntimeConfigurationNamespace(runtimeConfiguration, this.namespace)');
    expect(worker).toContain('workerRuntimeCacheDirectory(');
    expect(prewarm).toContain('workerRuntimeCacheDirectory(');
    expect(prewarm).toContain('cacheRoot,');
    expect(prewarm).toContain('process.env.AF_CACHE_DIR = cacheDir');
  });
});
