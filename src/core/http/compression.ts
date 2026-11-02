import type { NextFunction, Request, Response } from 'express';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

/**
 * Compressão de resposta para o acesso pela rede local.
 *
 * O Kivo é servido pela máquina da loja (Electron/Express), e o celular/tablet acessa
 * pelo Wi-Fi. Nesse caminho, o HTML do PDV (~170 KB), o app.css (~220 KB) e o Alpine
 * viajam SEM compressão hoje — é o que faz a navegação no celular parecer lenta mesmo
 * com a rede funcionando. Este middleware responde com brotli (ou gzip, para clientes
 * antigos) quando o navegador aceita, sem adicionar dependência de npm.
 *
 * Decisões:
 *  - `text/event-stream` (SSE de pedido pronto) NUNCA é bufferizado: o evento precisa
 *    chegar na hora, e comprimir um stream infinito quebraria o canal.
 *  - Imagens/áudio já são comprimidos no formato; ficam de fora.
 *  - Respostas pequenas (< 1 KB) não compensam o custo do cabeçalho.
 *  - O resultado de arquivos estáticos é guardado em memória por ETag. Sem isso, cada
 *    celular que abre o PDV faria o servidor comprimir o mesmo app.css de novo.
 */
const MIN_SIZE = 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 80;
const MAX_CACHE_BODY = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 24 * 1024 * 1024;

const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|manifest\+json|wasm)|image\/svg\+xml)/i;

type Encoding = 'br' | 'gzip';

interface CachedVariant {
  br?: Buffer;
  gzip?: Buffer;
  at: number;
}

/** Só assets públicos entram no cache — nunca HTML autenticado nem resposta de API. */
const compressedCache = new Map<string, CachedVariant>();
let compressedCacheBytes = 0;

function cacheKey(req: Request, etag: string): string {
  return `${req.path}|${etag}`;
}

function entryBytes(entry: CachedVariant): number {
  return (entry.br?.length ?? 0) + (entry.gzip?.length ?? 0);
}

function isStaticAsset(pathname: string): boolean {
  return /^\/(?:css|js|vendor|img|sons|uploads)\//.test(pathname);
}

function pruneCache(): void {
  while (compressedCache.size > MAX_CACHE_ENTRIES || compressedCacheBytes > MAX_CACHE_BYTES) {
    const oldest = compressedCache.keys().next().value;
    if (oldest === undefined) break;
    const entry = compressedCache.get(oldest);
    if (entry) compressedCacheBytes -= entryBytes(entry);
    compressedCache.delete(oldest);
  }
}

function pickEncoding(req: Request): Encoding | null {
  const raw = String(req.headers['accept-encoding'] ?? '');
  if (!raw) return null;
  // q=0 significa "não aceito". A checagem simples cobre os navegadores reais; um
  // Accept-Encoding malformado cai no gzip, que é universal.
  const accepts = (name: string) => new RegExp(`(?:^|,)\\s*${name}\\s*(?:;|,|$)`, 'i').test(raw)
    && !new RegExp(`(?:^|,)\\s*${name}\\s*;\\s*q=0(?:\\.0+)?\\s*(?:,|$)`, 'i').test(raw);
  if (accepts('br')) return 'br';
  if (accepts('gzip')) return 'gzip';
  return null;
}

function addVary(res: Response): void {
  const current = String(res.getHeader('Vary') ?? '');
  if (!/\bAccept-Encoding\b/i.test(current)) {
    res.setHeader('Vary', current ? `${current}, Accept-Encoding` : 'Accept-Encoding');
  }
}

function toBuffer(chunk: unknown, encoding?: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  }
  return Buffer.from(String(chunk ?? ''));
}

function compress(body: Buffer, encoding: Encoding): Buffer {
  if (encoding === 'br') {
    return brotliCompressSync(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return gzipSync(body, { level: 6 });
}

export function compression(): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (req.method === 'HEAD') {
      next();
      return;
    }
    const encoding = pickEncoding(req);
    if (!encoding) {
      next();
      return;
    }

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const writeOriginal = (chunk: unknown, encoding?: unknown, cb?: unknown): boolean =>
      originalWrite(chunk as never, encoding as never, cb as never);

    let mode: 'undecided' | 'buffer' | 'passthrough' = 'undecided';
    let chunks: Buffer[] = [];
    let buffered = 0;

    const flushBuffer = (): void => {
      for (const chunk of chunks) originalWrite(chunk);
      chunks = [];
      buffered = 0;
    };

    const bypass = (chunk?: unknown, chunkEncoding?: unknown, cb?: unknown): void => {
      mode = 'passthrough';
      flushBuffer();
      if (chunk !== undefined) writeOriginal(chunk, chunkEncoding, cb);
    };

    const decide = (firstChunk: Buffer): boolean => {
      const status = res.statusCode;
      // 204/304 e respostas de erro mínimo não têm corpo útil para comprimir.
      if (status === 204 || status === 304 || status < 200) return false;
      if (res.getHeader('Content-Encoding')) return false;
      if (String(res.getHeader('Cache-Control') ?? '').toLowerCase().includes('no-transform')) return false;
      const type = String(res.getHeader('Content-Type') ?? '');
      if (/^text\/event-stream/i.test(type)) return false;
      if (!COMPRESSIBLE.test(type)) return false;

      const declared = Number(res.getHeader('Content-Length'));
      if (Number.isFinite(declared) && declared > 0) {
        if (declared < MIN_SIZE || declared > MAX_BUFFER) return false;
      } else if (firstChunk.length > MAX_BUFFER) {
        return false;
      }
      return true;
    };

    (res as unknown as { write: typeof res.write }).write = function write(
      chunk: unknown,
      chunkEncoding?: unknown,
      cb?: unknown,
    ): boolean {
      if (mode === 'passthrough') {
        originalWrite(chunk as never, chunkEncoding as never, cb as never);
        return true;
      }
      const buf = toBuffer(chunk, chunkEncoding);
      if (mode === 'undecided') {
        if (!decide(buf)) {
          bypass(chunk, chunkEncoding, cb);
          return true;
        }
        mode = 'buffer';
      }
      chunks.push(buf);
      buffered += buf.length;
      if (buffered > MAX_BUFFER) bypass();
      return true;
    } as typeof res.write;

    (res as unknown as { end: typeof res.end }).end = function end(
      chunk?: unknown,
      chunkEncoding?: unknown,
      cb?: unknown,
    ): Response {
      if (chunk !== undefined && chunk !== null) {
        const buf = toBuffer(chunk, chunkEncoding);
        if (mode === 'undecided') {
          if (decide(buf)) mode = 'buffer';
          else bypass();
        }
        if (mode === 'buffer') {
          chunks.push(buf);
          buffered += buf.length;
        }
      }

      if (mode === 'passthrough') {
        originalEnd(chunk as never, chunkEncoding as never, cb as never);
        return res;
      }

      if (mode === 'undecided' || buffered < MIN_SIZE) {
        mode = 'passthrough';
        flushBuffer();
        originalEnd(undefined as never, undefined as never, cb as never);
        return res;
      }

      // Reúne o corpo (poucos buffers) e comprime de uma vez. Só chega aqui conteúdo
      // textual acima do limite e abaixo do teto de 8 MB.
      const body = Buffer.concat(chunks, buffered);
      chunks = [];
      buffered = 0;

      const etag = String(res.getHeader('ETag') ?? '');
      const canCache = req.method === 'GET' && !!etag && isStaticAsset(req.path);
      const key = canCache ? cacheKey(req, etag) : '';

      let compressed: Buffer | undefined;
      if (canCache) {
        const cached = compressedCache.get(key);
        if (cached) {
          cached.at = Date.now();
          compressed = encoding === 'br' ? cached.br : cached.gzip;
        }
      }
      if (!compressed) {
        compressed = compress(body, encoding);
        if (canCache && compressed.length <= MAX_CACHE_BODY) {
          const previous = compressedCache.get(key);
          if (previous) {
            compressedCacheBytes -= entryBytes(previous);
            compressedCache.delete(key);
          }
          const cached = previous ?? { at: Date.now() };
          if (encoding === 'br') cached.br = compressed;
          else cached.gzip = compressed;
          cached.at = Date.now();
          compressedCache.set(key, cached);
          compressedCacheBytes += compressed.length;
          pruneCache();
        }
      }

      addVary(res);
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', String(compressed.length));
      // O ETag do express.static foi calculado sobre o corpo ORIGINAL. Como agora a
      // resposta é outra representação (comprimida), ele precisa ser fraco.
      if (etag && !etag.startsWith('W/')) res.setHeader('ETag', `W/${etag}`);
      res.removeHeader('Content-MD5');
      try {
        originalWrite(compressed);
        originalEnd(undefined as never, undefined as never, cb as never);
      } catch {
        // Cliente desconectou no meio; não há o que responder.
        if (!res.headersSent) originalEnd();
      }
      return res;
    } as typeof res.end;

    next();
  };
}
