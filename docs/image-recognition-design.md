# 本地代理与图片识别技术方案

## 1. 背景与目标

目前 Wukong Bot 使用 Claude Code CLI 作为执行引擎。为了支持多模态（图片识别）能力，且充分利用国内高性能模型（如火山引擎 Doubao-Seed-Code），我们需要一种非侵入式的方案来拦截和处理图片请求。

**目标**：
1.  **非侵入式**：不修改 Claude Code CLI 源码，不修改 Wukong Bot 核心逻辑。
2.  **图片识别**：支持接收并处理图片消息。
3.  **模型路由**：当检测到图片时，自动路由到支持视觉能力的模型（如 `doubao-seed-code-preview-latest`）。
4.  **本地代理**：通过本地 HTTP 代理拦截 Claude Code CLI 的请求。

---

## 2. 方案可行性分析

### 2.1 关键验证点

| 环节 | 是否可行 | 依据 |
| :--- | :--- | :--- |
| **本地代理拦截** | ✅ | Claude Code CLI 官方支持 `ANTHROPIC_BASE_URL` 环境变量指向自定义代理。 |
| **图片检测** | ✅ | 请求体为标准 JSON，图片以 `type: "image"` 或 `source.type: "base64"` 格式存在，易于解析。 |
| **模型支持** | ✅ | **Doubao-Seed-Code** 是国内首个原生支持视觉理解的编程模型，API 支持 `image_url` 输入。 |

### 2.2 核心逻辑

1.  **启动本地代理**：一个轻量级的 HTTP Server (Express/Fastify)。
2.  **指向代理**：设置 `export ANTHROPIC_BASE_URL="http://localhost:8080"`。
3.  **请求拦截**：
    *   解析 `/v1/messages` 请求体。
    *   **检测图片**：遍历 `messages[].content[]`，查找是否有图片类型。
    *   **动态路由**：
        *   **有图片** ➔ 强制修改 `model` 为 `doubao-seed-code-preview-latest`。
        *   **无图片** ➔ 保持原 `model` 或使用默认配置。
4.  **格式转换**：
    *   **请求**：Claude (Anthropic 格式) ➔ 火山方舟 (OpenAI 兼容格式)。
        *   `type: "image"` ➔ `type: "image_url"`。
    *   **响应**：火山方舟 (OpenAI SSE) ➔ Claude (Anthropic SSE)。
5.  **转发执行**：将修改后的请求发送给火山方舟 API (`https://ark.cn-beijing.volces.com/api/coding`)。

---

## 3. 具体实现方案

### 3.1 代理服务代码 (`claude-code-router.ts`)

```typescript
import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json({ limit: '50mb' })); // 支持大图片 Payload

const ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding';
const ARK_API_KEY = process.env.ARK_API_KEY!;

// 检测请求中是否包含图片
function hasImageContent(messages: any[]): boolean {
  return messages.some(msg => 
    Array.isArray(msg.content) && 
    msg.content.some((block: any) => 
      block.type === 'image' || block.type === 'image_url' || block.source?.type === 'base64'
    )
  );
}

// 拦截 Claude Code 的 /v1/messages 请求
app.post('/v1/messages', async (req, res) => {
  const body = req.body;

  // 1. 路由策略
  if (hasImageContent(body.messages || [])) {
    body.model = 'doubao-seed-code-preview-latest';
    console.log('[Router] 📸 检测到图片 → 路由至 doubao-seed-code-preview-latest');
    
    // 2. 格式转换 (Anthropic -> OpenAI)
    // 注意：这里需要实现具体的转换逻辑，将 Anthropic 的 image block 转为 OpenAI image_url 格式
    // transformAnthropicToOpenAI(body);
  } else {
    console.log(`[Router] 📝 纯文本 → 使用模型 ${body.model}`);
  }

  try {
    // 3. 转发到火山方舟
    const arkResp = await fetch(`${ARK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ARK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // 4. 流式转发响应
    res.status(arkResp.status);
    arkResp.body?.pipe(res);
    
  } catch (e) {
    console.error('[Router] 转发失败:', e);
    res.status(500).json({ error: 'Proxy Error' });
  }
});

app.listen(8080, () => {
  console.log('[Router] 🚀 本地代理启动于 http://localhost:8080');
});
```

### 3.2 启动与配置

```bash
# 1. 启动本地代理
export ARK_API_KEY="sk-xxxxxxxx"
bun run claude-code-router.ts

# 2. 配置 Claude Code CLI 指向代理
export ANTHROPIC_BASE_URL="http://localhost:8080"

# 3. 运行 Wukong Bot
bun run dev
```

---

## 4. 关键挑战与解决方案 (Pitfalls)

| 问题 | 说明 | 解决方案 |
| :--- | :--- | :--- |
| **API 格式差异** | Claude 使用 Anthropic Messages API，火山方舟兼容 OpenAI API。 | **代理层转换**：<br>1. 请求：`type: "image"` ➔ `type: "image_url"`。<br>2. 响应：SSE 格式转换 (Coding Plan 中间件已处理部分兼容性，代理层需确保透传或微调)。 |
| **图片大小限制** | 飞书原图可能很大，导致 API 请求体超过限制或 Token 溢出。 | **压缩处理**：在代理层解析 Base64，压缩至合理尺寸（如 1024x1024），再重新编码发送。 |
| **鉴权机制** | `ANTHROPIC_API_KEY` 可能会被 CLI 自动添加。 | 代理层忽略传入的 Anthropic Key，强制使用环境变量中的 `ARK_API_KEY`。 |

---

## 5. 总结

本方案通过引入一个轻量级的**本地 HTTP 代理**，巧妙地解决了多模态模型路由问题。它无需修改任何现有业务代码，即可让 Claude Code CLI 具备“视觉”，利用 Doubao-Seed-Code 的强大能力处理图片输入。这是实现 Wukong Bot 视觉能力的**最优雅、最低成本**的路径。
