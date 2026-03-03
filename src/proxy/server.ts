
import express from 'express';
import fetch from 'node-fetch';
import { logger } from '../utils/logger';

const app = express();
app.use(express.json({ limit: '50mb' })); // 支持大图片 Payload

const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding';

// 检测请求中是否包含图片
function hasImageContent(messages: any[]): boolean {
  if (!Array.isArray(messages)) return false;
  
  return messages.some(msg => 
    Array.isArray(msg.content) && 
    msg.content.some((block: any) => 
      block.type === 'image' || 
      block.type === 'image_url' || 
      block.source?.type === 'base64'
    )
  );
}

// 转换 Anthropic 图片格式到 OpenAI 格式
function transformImageContent(content: any[]): any[] {
  return content.map(block => {
    if (block.type === 'image' && block.source?.type === 'base64') {
      const mediaType = block.source.media_type || 'image/jpeg';
      const base64Data = block.source.data;
      
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mediaType};base64,${base64Data}`
        }
      };
    }
    return block;
  });
}

// 拦截 Claude Code 的 /v1/messages 请求
app.post('/v1/messages', async (req, res) => {
  const body = req.body;
  const requestId = Math.random().toString(36).substring(7);

  // 1. 路由策略
  if (hasImageContent(body.messages || [])) {
    logger.info(`[Proxy:${requestId}] 📸 Detected image content, routing to doubao-seed-code`);
    
    // 强制使用支持视觉的模型
    body.model = 'doubao-seed-code-preview-latest';
    
    // 转换消息格式
    if (Array.isArray(body.messages)) {
      body.messages = body.messages.map((msg: any) => ({
        ...msg,
        content: Array.isArray(msg.content) ? transformImageContent(msg.content) : msg.content
      }));
    }
  } else {
    logger.info(`[Proxy:${requestId}] 📝 Text-only content, using model: ${body.model}`);
  }

  // 如果没有配置 ARK_API_KEY，直接报错
  // if (!ARK_API_KEY) {
  //   logger.error(`[Proxy:${requestId}] ARK_API_KEY not configured`);
  //   res.status(500).json({ 
  //     error: {
  //       type: 'server_error',
  //       message: 'ARK_API_KEY is not configured in .env'
  //     }
  //   });
  //   return;
  // }

  try {
    // 3. 转发到火山方舟
    const upstreamUrl = process.env.UPSTREAM_BASE_URL || ARK_BASE_URL;
    logger.info(`[Proxy:${requestId}] Forwarding to ${upstreamUrl}/chat/completions`);
    
    // 透传所有 Header（除了 host 和 content-length，node-fetch 会自动处理）
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (key !== 'host' && key !== 'content-length' && typeof value === 'string') {
            headers[key] = value;
        }
    }
    
    // 强制设置为 JSON
    headers['Content-Type'] = 'application/json';

    const arkResp = await fetch(`${upstreamUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!arkResp.ok) {
      const errorText = await arkResp.text();
      logger.error(`[Proxy:${requestId}] Upstream error ${arkResp.status}: ${errorText}`);
      res.status(arkResp.status).send(errorText);
      return;
    }

    // 4. 流式转发响应
    res.status(arkResp.status);
    
    // 设置响应头，支持 SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    arkResp.body?.pipe(res);
    
    // 监听结束
    res.on('close', () => {
      logger.info(`[Proxy:${requestId}] Request completed`);
    });
    
  } catch (e) {
    logger.error(`[Proxy:${requestId}] Proxy failed:`, e);
    res.status(500).json({ 
      error: {
        type: 'proxy_error',
        message: String(e)
      }
    });
  }
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', provider: 'volcano-ark' });
});

// 启动服务
const PORT = parseInt(process.env.PROXY_PORT || '8080', 10);

export function startProxyServer() {
  app.listen(PORT, () => {
    logger.info(`[Proxy] 🚀 Local proxy server running at http://localhost:${PORT}`);
    logger.info(`[Proxy] Configure Claude CLI with: export ANTHROPIC_BASE_URL="http://localhost:${PORT}"`);
  });
}

// 如果直接运行此脚本
if (import.meta.main) {
  startProxyServer();
}
