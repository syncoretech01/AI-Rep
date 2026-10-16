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
      // The admin app must never be framed (clickjacking).
      {
        source: '/((?!widget/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
      // The chat widget page is designed to be embedded on customer websites.
      {
        source: '/widget/:path*',
        headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }],
      },
      { source: '/embed.js', headers: [{ key: 'Cache-Control', value: 'public, max-age=300' }] },
    ]);
  },
};

export default nextConfig;
