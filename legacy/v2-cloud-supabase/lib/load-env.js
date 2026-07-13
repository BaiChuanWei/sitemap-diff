/**
 * 加载本地环境变量
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

try {
  const envPath = resolve(__dirname, '../.dev.vars');
  const envContent = readFileSync(envPath, 'utf-8');

  envContent.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;

    const [key, ...values] = line.split('=');
    if (key && values.length > 0) {
      const value = values.join('=').trim();
      process.env[key.trim()] = value;
    }
  });

  console.log('✅ 环境变量已加载');
} catch (error) {
  console.warn('⚠️  未找到 .dev.vars 文件，跳过本地环境变量加载');
}
