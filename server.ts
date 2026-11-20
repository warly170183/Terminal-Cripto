import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProd = process.env.NODE_ENV === 'production';

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
