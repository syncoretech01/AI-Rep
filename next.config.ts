import type { NextConfig } from 'next';

const baseSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // The repository's agent rules live in CLAUDE.md; don't let `next dev` generate AGENTS.md.
  agentRules: false,
  experimental: {
    // Knowledge uploads (TXT/Markdown, max 1 MB) go through Server Actions.
    serverActions: { bodySizeLimit: '2mb' },
  },
  headers() {
    return Promise.resolve([
      { source: '/:path*', headers: baseSecurityHeaders },
      // The developer voice lab needs the microphone (same origin only); everything else keeps it disabled.
      {
        source: '/o/:orgSlug/voice-lab',
        headers: [{ key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' }],
      },
      // The admin app must never be framed (clickjacking).
      {
        source: '/((?!widget/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
      // The chat widget page is embedded on customer websites: its frame-ancestors policy is set per widget by the
      // proxy (src/server/channels/webchat/frame-policy.ts), from the widget's allowed sites.
      { source: '/embed.js', headers: [{ key: 'Cache-Control', value: 'public, max-age=300' }] },
    ]);
  },
};

export default nextConfig;
