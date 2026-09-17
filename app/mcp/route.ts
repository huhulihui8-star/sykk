import { createMcpHandler } from '@modelcontextprotocol/server';
import { createMarketMcpServer } from '@/lib/mcp-server';
import { isMcpRequestAuthorized } from '@/lib/mcp-auth';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const handler = createMcpHandler(createMarketMcpServer, {
  legacy: 'stateless',
  responseMode: 'json',
});

function withCors(response: Response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'authorization, x-mcp-api-key, content-type, mcp-protocol-version, mcp-session-id',
  );
  headers.set(
    'Access-Control-Expose-Headers',
    'mcp-protocol-version, mcp-session-id',
  );
  return new Response(response.body, { status: response.status, headers });
}

async function getMcpApiKey() {
  try {
    const workers = await import('cloudflare:workers');
    const runtimeEnv = workers.env as unknown as Record<string, unknown>;
    const value = runtimeEnv.MCP_API_KEY;
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    // Node-based test and build environments do not expose Cloudflare bindings.
  }

  return process.env.MCP_API_KEY;
}

function unauthorized() {
  return withCors(
    Response.json(
      {
        error: 'unauthorized',
        message: 'A valid MCP API key is required.',
      },
      {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="strongest-analyst-mcp"' },
      },
    ),
  );
}

async function serve(request: Request) {
  if (!isMcpRequestAuthorized(request, await getMcpApiKey())) {
    return unauthorized();
  }
  return withCors(await handler.fetch(request));
}

export const GET = serve;
export const POST = serve;
export const DELETE = serve;

export function OPTIONS() {
  return withCors(new Response(null, { status: 204 }));
}
