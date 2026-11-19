import type { Request, Response } from 'express';
import { getApp } from '../server';

// Vercel routes /api/* requests to this catch-all Serverless Function.
// The original Express API paths remain unchanged.
export default async function handler(req: Request, res: Response) {
  try {
    const app = await getApp();
    return app(req, res);
  } catch (error) {
    console.error('[ZentoPay API] initialization failed:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        configured: false,
        code: 'API_INITIALIZATION_FAILED',
        error: 'সার্ভার চালু করা যায়নি। অনুগ্রহ করে পরে আবার চেষ্টা করুন।',
      });
    }
  }
}
