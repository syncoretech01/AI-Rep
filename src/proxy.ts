import type { NextRequest } from 'next/server';
import { updateSession } from '@/server/auth/proxy-session';

export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and the public widget surface (embed.js, /widget/*, /api/widget/*):
    // widget traffic carries no admin cookies and must never trigger session refreshes.
    '/((?!_next/static|_next/image|favicon\\.ico|embed\\.js|widget(?:/|$)|api/widget(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)',
  ],
};
