// Writes ~/.affine/config/config.json from environment variables, so storage
// lives in R2 and no state depends on the ephemeral container disk.
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const env = process.env;

function required(name) {
  const value = env[name];
  if (!value) {
    console.error(`${name} is required. See .cloudflare/README.md.`);
    process.exit(1);
  }
  return value;
}

function r2(bucket) {
  return {
    provider: 'cloudflare-r2',
    bucket,
    config: {
      accountId: required('R2_ACCOUNT_ID'),
      region: 'auto',
      ...(env.R2_JURISDICTION ? { jurisdiction: env.R2_JURISDICTION } : {}),
      credentials: {
        accessKeyId: required('R2_ACCESS_KEY_ID'),
        secretAccessKey: required('R2_SECRET_ACCESS_KEY'),
      },
    },
  };
}

const configPath = path.join(homedir(), '.affine/config/config.json');
const existing = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  : {};

const config = {
  ...existing,
  $schema:
    'https://github.com/toeverything/affine/releases/latest/download/config.schema.json',
  deployment: { type: 'selfhosted' },
  server: {
    ...existing.server,
    name: env.AFFINE_SERVER_NAME || 'AFFiNE',
    externalUrl: required('AFFINE_SERVER_EXTERNAL_URL'),
  },
  storages: {
    ...existing.storages,
    'blob.storage': r2(env.R2_BLOB_BUCKET || 'affine-blobs'),
    'avatar.storage': r2(env.R2_AVATAR_BUCKET || 'affine-avatars'),
  },
  copilot: {
    ...existing.copilot,
    // The workspace MCP endpoint (including the ticket tools) is served by the
    // copilot plugin. AI providers stay off until a workspace configures BYOK.
    enabled: env.AFFINE_COPILOT_ENABLED !== 'false',
    storage: r2(env.R2_COPILOT_BUCKET || 'affine-copilot'),
  },
  ...(env.MAILER_HOST
    ? {
        mailer: {
          ...existing.mailer,
          'SMTP.host': env.MAILER_HOST,
          'SMTP.port': Number(env.MAILER_PORT || 587),
          'SMTP.username': env.MAILER_USER || '',
          'SMTP.password': env.MAILER_PASSWORD || '',
          'SMTP.sender': required('MAILER_SENDER'),
          'SMTP.ignoreTLS': env.MAILER_IGNORE_TLS === 'true',
        },
      }
    : {}),
  indexer: {
    enabled: true,
    'provider.type': 'embedded',
    ...existing.indexer,
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', {
  mode: 0o600,
});
console.log(`wrote ${configPath}`);
