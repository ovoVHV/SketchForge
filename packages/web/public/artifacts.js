const fromBase64 = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const hex = (bytes) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');

/** Download (or decode legacy base64) and verify a compiler artifact. */
export async function artifactBytes(artifact) {
  let bytes;
  if (typeof artifact?.url === 'string' && artifact.url) {
    const response = await fetch(artifact.url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`固件下载失败：HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else if (typeof artifact?.base64 === 'string') {
    bytes = fromBase64(artifact.base64);
  } else {
    throw new Error('编译结果缺少固件下载地址');
  }

  if (bytes.length !== artifact.size) throw new Error('固件长度校验失败');
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (digest !== artifact.sha256) throw new Error('固件完整性校验失败');
  return bytes;
}

export async function artifactText(artifact) {
  return new TextDecoder().decode(await artifactBytes(artifact));
}
