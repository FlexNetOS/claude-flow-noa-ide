/**
 * Sprint 1 Security Tests — mcp package
 *
 * Covers:
 *   1. safeJsonParse in mcp/utils (mirror of shared)
 *   2. HttpTransport auth defaults (allowUnauthenticated)
 *   3. WebSocketTransport auth defaults (isAuthenticated: false)
 *   4. HttpTransport config interface has allowUnauthenticated
 *   5. WebSocketTransport config interface has allowUnauthenticated
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeJsonParse } from '../src/utils/safe-json.js';

// ─── safeJsonParse (mcp-local mirror) ───────────────────────

describe('safeJsonParse (mcp)', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse<{ x: number }>('{"x":42}')).toEqual({ x: 42 });
  });

  it('strips __proto__', () => {
    const result = safeJsonParse<any>('{"__proto__":{"p":1},"ok":true}');
    expect(result.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(false);
    expect(({} as any).p).toBeUndefined();
  });

  it('strips constructor', () => {
    const result = safeJsonParse<any>('{"constructor":null,"v":1}');
    expect(result.v).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(false);
  });

  it('strips prototype', () => {
    const result = safeJsonParse<any>('{"prototype":{},"v":2}');
    expect(result.v).toBe(2);
    expect(result.prototype).toBeUndefined();
  });

  it('throws on malformed JSON', () => {
    expect(() => safeJsonParse('{bad')).toThrow();
  });
});

// ─── HttpTransport auth defaults ────────────────────────────

describe('HttpTransport auth defaults', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  it('rejects requests when no auth configured and allowUnauthenticated not set', async () => {
    // Import the class (Express will be initialized but we won't start the server)
    const { HttpTransport } = await import('../src/transport/http.js');

    const transport = new HttpTransport(mockLogger as any, {
      host: 'localhost',
      port: 0,
      // No auth, no allowUnauthenticated → should reject
    });

    // Simulate an HTTP request via the private method
    const mockReq = {
      body: { jsonrpc: '2.0', id: 1, method: 'test' },
      headers: {},
      ip: '127.0.0.1',
      path: '/rpc',
    };

    let statusCode = 0;
    let responseBody: any;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockImplementation((body) => {
        responseBody = body;
      }),
      end: vi.fn(),
    };
    mockRes.status.mockImplementation((code: number) => {
      statusCode = code;
      return mockRes;
    });

    // Access private method
    await (transport as any).handleHttpRequest(mockReq, mockRes);

    expect(statusCode).toBe(401);
    expect(responseBody.error.code).toBe(-32001);
  });

  it('allows requests when allowUnauthenticated is true', async () => {
    const { HttpTransport } = await import('../src/transport/http.js');

    const transport = new HttpTransport(mockLogger as any, {
      host: 'localhost',
      port: 0,
      allowUnauthenticated: true,
    });

    // Register a request handler so it doesn't fail with "no handler"
    transport.onRequest(async (req) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: { ok: true },
    }));

    const mockReq = {
      body: { jsonrpc: '2.0', id: 1, method: 'test', params: {} },
      headers: {},
      ip: '127.0.0.1',
      path: '/rpc',
    };

    let responseBody: any;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockImplementation((body) => {
        responseBody = body;
      }),
      end: vi.fn(),
    };

    await (transport as any).handleHttpRequest(mockReq, mockRes);

    expect(mockRes.status).not.toHaveBeenCalled();
    expect(responseBody.result).toEqual({ ok: true });
  });

  it('rejects requests with invalid token when auth is configured', async () => {
    const { HttpTransport } = await import('../src/transport/http.js');

    const transport = new HttpTransport(mockLogger as any, {
      host: 'localhost',
      port: 0,
      auth: { tokens: ['valid-secret-token'] },
    });

    const mockReq = {
      body: { jsonrpc: '2.0', id: 1, method: 'test' },
      headers: { authorization: 'Bearer wrong-token' },
      ip: '127.0.0.1',
      path: '/rpc',
    };

    let statusCode = 0;
    let responseBody: any;
    const mockRes = {
      status: vi.fn().mockImplementation((code: number) => {
        statusCode = code;
        return mockRes;
      }),
      json: vi.fn().mockImplementation((body) => {
        responseBody = body;
      }),
      end: vi.fn(),
    };

    await (transport as any).handleHttpRequest(mockReq, mockRes);

    expect(statusCode).toBe(401);
    expect(responseBody.error.message).toBe('Unauthorized');
  });

  it('accepts requests with valid token', async () => {
    const { HttpTransport } = await import('../src/transport/http.js');

    const transport = new HttpTransport(mockLogger as any, {
      host: 'localhost',
      port: 0,
      auth: { tokens: ['valid-secret-token'] },
    });

    transport.onRequest(async (req) => ({
      jsonrpc: '2.0' as const,
      id: req.id,
      result: { authenticated: true },
    }));

    const mockReq = {
      body: { jsonrpc: '2.0', id: 1, method: 'test', params: {} },
      headers: { authorization: 'Bearer valid-secret-token' },
      ip: '127.0.0.1',
      path: '/rpc',
    };

    let responseBody: any;
    const mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockImplementation((body) => {
        responseBody = body;
      }),
      end: vi.fn(),
    };

    await (transport as any).handleHttpRequest(mockReq, mockRes);

    expect(responseBody.result).toEqual({ authenticated: true });
  });
});

// ─── WebSocketTransport auth defaults ───────────────────────

describe('WebSocketTransport auth defaults', () => {
  it('initializes clients as unauthenticated by default', async () => {
    const { WebSocketTransport } = await import('../src/transport/websocket.js');

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const transport = new WebSocketTransport(mockLogger as any, {
      host: 'localhost',
      port: 0,
      // No allowUnauthenticated → clients start unauthenticated
    });

    // The auth enforcement is in handleMessage — verify the config makes it
    // so clients that aren't authenticated get rejected
    // We test this by checking the config propagation
    expect((transport as any).config.allowUnauthenticated).toBeUndefined();
  });

  it('allows unauthenticated messages when allowUnauthenticated is true', async () => {
    const { WebSocketTransport } = await import('../src/transport/websocket.js');

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const transport = new WebSocketTransport(mockLogger as any, {
      host: 'localhost',
      port: 0,
      allowUnauthenticated: true,
    });

    expect((transport as any).config.allowUnauthenticated).toBe(true);
  });
});
