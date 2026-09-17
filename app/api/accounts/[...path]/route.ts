import { handleAccountRequest } from '@/lib/account-http';
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  const { path } = await context.params;
  return handleAccountRequest(request, path.join('/'));
}
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
