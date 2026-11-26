import type { NextRequest } from 'next/server';
import { updateSession } from '@/server/auth/proxy-session';
import { widgetFrameResponse } from '@/server/channels/webchat/proxy-frame';

export function proxy(request: NextRequest) {
  // The embeddable widget page gets its per-widget frame-ancestors policy; it carries no admin session.
  const { pathname } = request.nextUrl;
  if (pathname === '/widget' || pathname.startsWith('/widget/')) return widgetFrameResponse(request);
  return updateSession(request);
}

export const config = {
  matcher: [
    // Everything except static assets and the public widget surface (embed.js, /widget/*, /api/widget/*):
    // widget traffic carries no admin cookies and must never trigger session refreshes.
    '/((?!_next/static|_next/image|favicon\\.ico|embed\\.js|widget(?:/|$)|api/widget(?:/|$)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico)$).*)',
    // The widget page itself: only its framing policy is applied (no session handling).
    '/widget/:path*',
  ],
};
