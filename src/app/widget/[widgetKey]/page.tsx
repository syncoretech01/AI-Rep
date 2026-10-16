import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ChatWidget } from '@/components/widget/ChatWidget';
import { getAppServices } from '@/server/app-services';
import { createLogger } from '@/server/observability/logger';
import { WIDGET_KEY_PATTERN, type PublicAgent } from '@/shared/widget-protocol';
import WidgetUnavailable from './not-found';

export const metadata: Metadata = { title: 'Chat', robots: { index: false, follow: false } };

interface WidgetPageProps {
  params: Promise<{ widgetKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The published agent, or null. A server failure degrades to the "unavailable" screen inside the host page. */
async function loadPublicAgent(widgetKey: string): Promise<PublicAgent | null> {
  try {
    return await getAppServices().webChat.describeWidget(widgetKey);
  } catch (error) {
    createLogger({ bindings: { module: 'widget.page' } }).error('widget.page_failed', { error });
    return null;
  }
}

/**
 * The visitor chat panel: loaded in an iframe by public/embed.js (`?embedded=1`) or opened
 * directly as the admin preview. Only the public agent (name, greeting, reply language) is
 * rendered here; everything else goes through the widget API.
 */
export default async function WidgetPage({ params, searchParams }: WidgetPageProps) {
  // Rendered per request: publishing, pausing or rotating the key must take effect immediately.
  await connection();
  const { widgetKey } = await params;
  if (!WIDGET_KEY_PATTERN.test(widgetKey)) notFound();
  const { embedded } = await searchParams;

  const agent = await loadPublicAgent(widgetKey);
  if (!agent) return <WidgetUnavailable />;
  return (
    <ChatWidget
      widgetKey={widgetKey}
      agentName={agent.name}
      greeting={agent.greeting}
      language={agent.language}
      embedded={embedded === '1'}
    />
  );
}
