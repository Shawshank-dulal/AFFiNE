import { Container, getContainer } from '@cloudflare/containers';

const AFFINE_PORT = 3010;
// A cold start runs database migrations before the server listens.
const BOOT_TIMEOUT_MS = 5 * 60 * 1000;

// Variables and secrets forwarded to the AFFiNE container.
const CONTAINER_ENV = [
  'DATABASE_URL',
  'AFFINE_PRIVATE_KEY',
  'AFFINE_SERVER_EXTERNAL_URL',
  'AFFINE_SERVER_NAME',
  'AFFINE_COPILOT_ENABLED',
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_JURISDICTION',
  'R2_BLOB_BUCKET',
  'R2_AVATAR_BUCKET',
  'R2_COPILOT_BUCKET',
  'REDIS_SERVER_URL',
  'MAILER_HOST',
  'MAILER_PORT',
  'MAILER_USER',
  'MAILER_PASSWORD',
  'MAILER_SENDER',
  'MAILMARIO_API_KEY',
  'MAILMARIO_API_URL',
] as const;

// Secrets are set with `wrangler secret put` and are not part of the
// generated `Env` type.
type ContainerEnv = Partial<Record<(typeof CONTAINER_ENV)[number], string>>;

export class AffineContainer extends Container<Env> {
  defaultPort = AFFINE_PORT;
  sleepAfter = '1h';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    if (env.AFFINE_SLEEP_AFTER) this.sleepAfter = env.AFFINE_SLEEP_AFTER;
    this.envVars = {
      AFFINE_SERVER_HTTPS: 'true',
      AFFINE_SERVER_PORT: String(AFFINE_PORT),
      DEPLOYMENT_TYPE: 'selfhosted',
      NODE_ENV: 'production',
    };
    for (const key of CONTAINER_ENV) {
      const value = (env as ContainerEnv)[key];
      if (value) this.envVars[key] = value;
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if ((await this.getState()).status !== 'healthy') {
      await this.startAndWaitForPorts({
        ports: AFFINE_PORT,
        cancellationOptions: {
          abort: request.signal,
          portReadyTimeoutMS: BOOT_TIMEOUT_MS,
        },
      });
    }
    return super.fetch(request);
  }
}

// Build output with a content hash in the file name, e.g.
// /js/index.b2a3c2ab.js or /styles.1056fe91.css. A new build gets new names,
// so these never change and can be cached for good.
const HASHED_ASSET =
  /^\/(?!api\/|graphql)[^?]*\.[0-9a-f]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|wasm)$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

function forwardToAffine(request: Request, env: Env) {
  // A single instance: the embedded Redis and realtime sync assume every
  // client talks to the same server process.
  return getContainer(env.AFFINE, 'affine').fetch(request);
}

// AFFiNE serves its hashed build files with `max-age=0`, so every page load
// would fetch megabytes of JavaScript from the container. Serve them from the
// edge cache instead, and let browsers keep them.
async function serveHashedAsset(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: 'GET' });
  const cached = await cache.match(key);
  if (cached) return cached;

  const response = await forwardToAffine(request, env);
  if (response.status !== 200) return response;

  const cacheable = new Response(response.body, response);
  cacheable.headers.set('cache-control', IMMUTABLE);
  cacheable.headers.delete('set-cookie');
  ctx.waitUntil(cache.put(key, cacheable.clone()));
  return cacheable;
}

export default {
  async fetch(request: Request, env: Env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && HASHED_ASSET.test(pathname)) {
      return serveHashedAsset(request, env, ctx);
    }
    return forwardToAffine(request, env);
  },
} satisfies ExportedHandler<Env>;
