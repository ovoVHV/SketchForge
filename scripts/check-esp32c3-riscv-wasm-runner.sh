#!/usr/bin/env bash
set -euo pipefail

readonly MIN_MEMORY_GIB="${ESP32C3_WASM_MIN_MEMORY_GIB:-16}"
readonly MIN_DISK_GIB="${ESP32C3_WASM_MIN_DISK_GIB:-30}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Linux" ]] || fail "the compiler build requires a Linux runner"
[[ "$(uname -m)" == "x86_64" ]] || fail "the pinned WASI SDK requires an x86_64 runner"
[[ "$MIN_MEMORY_GIB" =~ ^[1-9][0-9]*$ ]] || fail "ESP32C3_WASM_MIN_MEMORY_GIB must be a positive integer"
[[ "$MIN_DISK_GIB" =~ ^[1-9][0-9]*$ ]] || fail "ESP32C3_WASM_MIN_DISK_GIB must be a positive integer"
command -v docker >/dev/null || fail "docker is not installed"
docker info >/dev/null || fail "the Docker daemon is unavailable"
docker buildx version >/dev/null || fail "docker buildx is unavailable"

readonly gib=$((1024 * 1024 * 1024))
readonly required_memory=$((MIN_MEMORY_GIB * gib))
readonly required_disk=$((MIN_DISK_GIB * gib))
readonly memory_bytes=$(awk '/^MemTotal:/ { print $2 * 1024; exit }' /proc/meminfo)

[[ "$memory_bytes" =~ ^[0-9]+$ ]] || fail "cannot determine total system memory"
(( memory_bytes >= required_memory )) || fail "CI builder runner has less than ${MIN_MEMORY_GIB} GiB RAM"

docker_root=$(docker info --format '{{.DockerRootDir}}')
[[ -n "$docker_root" ]] || fail "cannot determine DockerRootDir"

workspace_path="${GITHUB_WORKSPACE:-$PWD}"
for path in "$workspace_path" "$docker_root"; do
  probe="$path"
  while [[ ! -e "$probe" && "$probe" != "/" ]]; do
    probe=$(dirname "$probe")
  done
  available=$(df -PB1 --output=avail "$probe" | awk 'NR == 2 { print $1 }')
  [[ "$available" =~ ^[0-9]+$ ]] || fail "cannot determine free disk for $path"
  (( available >= required_disk )) || fail "$path has less than ${MIN_DISK_GIB} GiB free"
  printf 'PASS disk %-24s %.1f GiB free\n' "$path" "$(awk -v bytes="$available" -v unit="$gib" 'BEGIN { print bytes / unit }')"
done

printf 'PASS CI builder memory %.1f GiB total\n' "$(awk -v bytes="$memory_bytes" -v unit="$gib" 'BEGIN { print bytes / unit }')"
printf 'PASS ESP32-C3 RISC-V WASM runner preflight\n'
