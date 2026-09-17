const BEARER_PREFIX = 'bearer ';

export function readMcpApiKey(request: Request) {
  const authorization = request.headers.get('authorization')?.trim() ?? '';
  if (authorization.toLowerCase().startsWith(BEARER_PREFIX)) {
    return authorization.slice(BEARER_PREFIX.length).trim();
  }

  return request.headers.get('x-mcp-api-key')?.trim() ?? '';
}

export function constantTimeEqual(left: string, right: string) {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}

export function isMcpRequestAuthorized(request: Request, expectedKey?: string) {
  if (!expectedKey) return false;
  const presentedKey = readMcpApiKey(request);
  return presentedKey.length > 0 && constantTimeEqual(presentedKey, expectedKey);
}

