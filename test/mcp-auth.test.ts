import assert from 'node:assert/strict';
import test from 'node:test';
import {
  constantTimeEqual,
  isMcpRequestAuthorized,
  readMcpApiKey,
} from '../lib/mcp-auth.ts';

test('reads bearer API keys without changing their case', () => {
  const request = new Request('https://example.com/api/mcp', {
    headers: { authorization: 'Bearer AbC-123' },
  });

  assert.equal(readMcpApiKey(request), 'AbC-123');
});

test('accepts the explicit MCP API key header as a client fallback', () => {
  const request = new Request('https://example.com/api/mcp', {
    headers: { 'x-mcp-api-key': 'secret' },
  });

  assert.equal(readMcpApiKey(request), 'secret');
  assert.equal(isMcpRequestAuthorized(request, 'secret'), true);
});

test('rejects missing, wrong, or unconfigured keys', () => {
  const missing = new Request('https://example.com/api/mcp');
  const wrong = new Request('https://example.com/api/mcp', {
    headers: { authorization: 'Bearer wrong' },
  });

  assert.equal(isMcpRequestAuthorized(missing, 'secret'), false);
  assert.equal(isMcpRequestAuthorized(wrong, 'secret'), false);
  assert.equal(isMcpRequestAuthorized(wrong), false);
});

test('constant-time comparison handles equal and unequal lengths', () => {
  assert.equal(constantTimeEqual('same', 'same'), true);
  assert.equal(constantTimeEqual('same', 'different'), false);
  assert.equal(constantTimeEqual('same', 'samp'), false);
});
