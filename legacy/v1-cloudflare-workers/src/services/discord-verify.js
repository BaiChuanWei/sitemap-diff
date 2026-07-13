/**
 * Discord 签名验证模块
 * 使用 Ed25519 验证 Discord webhook 请求的真实性
 */

/**
 * 验证 Discord 请求签名
 * @param {string} body - 请求体（原始文本）
 * @param {string} signature - X-Signature-Ed25519 头
 * @param {string} timestamp - X-Signature-Timestamp 头
 * @param {string} publicKey - Discord 应用的 Public Key
 * @returns {Promise<boolean>} 验证是否通过
 */
export async function verifyDiscordSignature(body, signature, timestamp, publicKey) {
  try {
    // 构建待验证的消息（timestamp + body）
    const message = timestamp + body;
    const encoder = new TextEncoder();
    const messageBytes = encoder.encode(message);

    // 将十六进制签名转换为字节数组
    const signatureBytes = hexToBytes(signature);

    // 将十六进制公钥转换为字节数组
    const publicKeyBytes = hexToBytes(publicKey);

    // 导入公钥
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      {
        name: 'Ed25519',
        namedCurve: 'Ed25519',
      },
      false,
      ['verify']
    );

    // 验证签名
    const isValid = await crypto.subtle.verify(
      'Ed25519',
      cryptoKey,
      signatureBytes,
      messageBytes
    );

    return isValid;
  } catch (error) {
    console.error('Discord 签名验证失败:', error);
    return false;
  }
}

/**
 * 将十六进制字符串转换为字节数组
 * @param {string} hex - 十六进制字符串
 * @returns {Uint8Array} 字节数组
 */
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
