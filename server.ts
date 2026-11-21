import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

type RssFeedSource = {
  id: string;
  name: string;
  url: string;
  category: 'crypto' | 'macro';
};

type RawNewsItem = {
  id: string;
  title: string;
  summary: string;
  link: string;
  source: string;
  sourceId: string;
  category: 'crypto' | 'macro';
  pubTs: number;
  pubIso: string;
};

const NEWS_FEEDS: RssFeedSource[] = [
  {
    id: 'coindesk',
    name: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    category: 'crypto',
  },
  {
    id: 'cointelegraph',
    name: 'Cointelegraph',
    url: 'https://cointelegraph.com/rss',
    category: 'crypto',
  },
  {
    id: 'blockworks',
    name: 'Blockworks',
    url: 'https://blockworks.co/feed',
    category: 'crypto',
  },
  {
    id: 'decrypt',
    name: 'Decrypt',
    url: 'https://decrypt.co/feed',
    category: 'crypto',
  },
  {
    id: 'fed',
    name: 'Federal Reserve',
    url: 'https://www.federalreserve.gov/feeds/press_all.xml',
    category: 'macro',
  },
];

let newsCache: {
  fetchedAt: number;
  payload: { updatedAt: number; sources: string[]; items: RawNewsItem[] };
} | null = null;
const NEWS_CACHE_TTL_MS = 60_000;

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;|&mdash;/g, '-')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block: string, tag: string): string {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = regex.exec(block);
  return match ? match[1].trim() : '';
}

function parseRssItems(xml: string, src: RssFeedSource): RawNewsItem[] {
  const items: RawNewsItem[] = [];
  const itemRegex = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = decodeHtmlEntities(extractTag(block, 'title'));
    if (!title) continue;

    const rawLink = extractTag(block, 'link') || extractTag(block, 'guid');
    const link = decodeHtmlEntities(rawLink);
    const rawDesc = extractTag(block, 'description');
    const summary = decodeHtmlEntities(rawDesc).slice(0, 260);
    const rawDate = decodeHtmlEntities(
      extractTag(block, 'pubDate') ||
        extractTag(block, 'dc:date') ||
        extractTag(block, 'updated')
    );
    const parsedTs = Date.parse(rawDate);
    if (!Number.isFinite(parsedTs)) continue;

    items.push({
      id: `${src.id}-${parsedTs}-${title.slice(0, 24).replace(/\W+/g, '').toLowerCase()}`,
      title,
      summary,
      link,
      source: src.name,
      sourceId: src.id,
      category: src.category,
      pubTs: parsedTs,
      pubIso: new Date(parsedTs).toISOString(),
    });
  }
  return items;
}

async function fetchAggregatedNews(forceRefresh = false) {
  if (!forceRefresh && newsCache && Date.now() - newsCache.fetchedAt < NEWS_CACHE_TTL_MS) {
    return newsCache.payload;
  }

  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (src) => {
      const response = await fetch(src.url, {
        headers: {
          Accept: 'application/rss+xml, application/xml, text/xml;q=0.9',
          'User-Agent': 'CryptoOptionsTerminal/1.0',
        },
        signal: AbortSignal.timeout(5500),
      });
      if (!response.ok) {
        throw new Error(`${src.name} HTTP ${response.status}`);
      }
      const xml = await response.text();
      return { src, items: parseRssItems(xml, src) };
    })
  );

  const collected: RawNewsItem[] = [];
  const activeSources: string[] = [];
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value.items.length > 0) {
      activeSources.push(res.value.src.name);
      collected.push(...res.value.items);
    }
  }

  // Deduplicate by normalized title and sort newest first.
  // Always keep all 'macro' items (Federal Reserve 45+ day archive) plus up to 90 crypto headlines.
  const seen = new Set<string>();
  const cryptoItems: RawNewsItem[] = [];
  const macroItems: RawNewsItem[] = [];
  for (const item of collected.sort((a, b) => b.pubTs - a.pubTs)) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 64);
    if (seen.has(key)) continue;
    seen.add(key);
    if (item.category === 'macro') {
      macroItems.push(item);
    } else if (cryptoItems.length < 90) {
      cryptoItems.push(item);
    }
  }
  const deduped = [...cryptoItems, ...macroItems].sort((a, b) => b.pubTs - a.pubTs);

  const payload = {
    updatedAt: Date.now(),
    sources: activeSources,
    items: deduped,
  };
  if (deduped.length > 0) {
    newsCache = { fetchedAt: Date.now(), payload };
  }
  return payload;
}

async function proxyJson(targetUrl: string, res: express.Response) {
  try {
    const response = await fetch(targetUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CryptoOptionsTerminal/1.0',
      },
    });
    const text = await response.text();
    res.status(response.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upstream fetch failed';
    res.status(502).json({ error: message });
  }
}

async function startServer() {
  const app = express();

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Live Crypto & Macro RSS News Aggregator
  app.get('/api/news', async (req, res) => {
    try {
      const force = req.query.refresh === '1';
      const payload = await fetchAggregatedNews(force);
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'News aggregation failed';
      res.status(502).json({ error: message, items: [], sources: [], updatedAt: Date.now() });
    }
  });

  // 100-day daily sentiment intensity series (Alternative.me Crypto Fear & Greed)
  app.get('/api/sentiment-history', async (_req, res) => {
    try {
      const response = await fetch('https://api.alternative.me/fng/?limit=100', {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'CryptoOptionsTerminal/1.0',
        },
        signal: AbortSignal.timeout(5500),
      });
      if (!response.ok) {
        res.status(response.status).json({ error: `Upstream FNG HTTP ${response.status}`, data: [] });
        return;
      }
      const json = (await response.json()) as {
        data?: { value: string; value_classification: string; timestamp: string }[];
      };
      const items = (json.data ?? [])
        .map((row) => ({
          ts: Number(row.timestamp) * 1000,
          value: Number(row.value),
          classification: row.value_classification,
        }))
        .filter((x) => Number.isFinite(x.ts) && Number.isFinite(x.value))
        .sort((a, b) => a.ts - b.ts);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ updatedAt: Date.now(), items });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sentiment history fetch failed';
      res.status(502).json({ error: message, items: [] });
    }
  });

  // OKX public v5 proxy (prevents browser CORS blocks)
  app.use('/api/okx', async (req, res) => {
    const upstreamPath = req.url;
    const targetUrl = `https://www.okx.com/api/v5${upstreamPath}`;
    await proxyJson(targetUrl, res);
  });

  // Deribit public v2 proxy (alternative OptionsProvider)
  app.use('/api/deribit', async (req, res) => {
    const upstreamPath = req.url;
    const targetUrl = `https://www.deribit.com/api/v2${upstreamPath}`;
    await proxyJson(targetUrl, res);
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
