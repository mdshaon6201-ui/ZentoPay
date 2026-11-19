import type { IncomingMessage, ServerResponse } from 'http';
import app from '../server.ts';

function normalizeVercelApiUrl(req: IncomingMessage) {
  const rawUrl = req.url || '/api';
  const parsed = new URL(rawUrl, 'http://localhost');
  const rewrittenPath = parsed.searchParams.get('__api_path');

  if (rewrittenPath !== null) {
    parsed.searchParams.delete('__api_path');
    const cleanSubPath = rewrittenPath.replace(/^\/+/, '');
    const nextPathname = cleanSubPath ? `/api/${cleanSubPath}` : '/api';
    const remainingQuery = parsed.searchParams.toString();
    req.url = remainingQuery ? `${nextPathname}?${remainingQuery}` : nextPathname;
    return;
  }

  if (parsed.pathname === '/api/index' || parsed.pathname === '/api/index.ts') {
    const headerOriginal =
      (req.headers['x-vercel-original-url'] as string | undefined) ||
      (req.headers['x-forwarded-uri'] as string | undefined);
    if (headerOriginal && headerOriginal.startsWith('/api')) {
      req.url = headerOriginal;
      return;
    }
    const remainingQuery = parsed.searchParams.toString();
    req.url = remainingQuery ? `/api?${remainingQuery}` : '/api';
    return;
  }

  if (!parsed.pathname.startsWith('/api')) {
    const remainingQuery = parsed.searchParams.toString();
    const cleanPath = parsed.pathname.replace(/^\/+/, '');
    const nextPathname = cleanPath ? `/api/${cleanPath}` : '/api';
    req.url = remainingQuery ? `${nextPathname}?${remainingQuery}` : nextPathname;
  }
}

export default function handler(req: IncomingMessage, res: ServerResponse) {
  normalizeVercelApiUrl(req);
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
