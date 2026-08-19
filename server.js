/**
 * Transit — JD 拆解与项目生成器 (Agent 版)
 * 本地代理服务器：静态文件服务 + Agent 循环 + 工具调用
 *
 * ┌─────────────── API 配置 ───────────────┐
 * │  修改下方三个常量后重启即可               │
 * └────────────────────────────────────────┘
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// PDF / Word 文本提取（延迟加载，避免未安装时报错）
let PDFParse = null;
let mammoth = null;
try { ({ PDFParse } = require('pdf-parse')); } catch(e) { console.log('  ⚠️ pdf-parse 未安装，简历上传(PDF)不可用'); }
try { mammoth = require('mammoth'); } catch(e) { console.log('  ⚠️ mammoth 未安装，简历上传(Word)不可用'); }

// ====== 在这里填写你的 API 配置 ======
// 推荐方式：把 Key 填进项目根目录的 .env 文件（DEEPSEEK_API_KEY=sk-xxx），启动时自动读取
// 也可以：本地运行时在终端设置 set DEEPSEEK_API_KEY=你的key（Windows）或 export DEEPSEEK_API_KEY=你的key（Mac/Linux）
const API_BASE_URL = 'https://api.deepseek.com/v1';

// 自动读取根目录 .env 文件（不覆盖已存在的系统环境变量）
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const envKey = trimmed.slice(0, eq).trim();
        const envValue = trimmed.slice(eq + 1).trim();
        if (!process.env[envKey]) process.env[envKey] = envValue;
      }
    }
  }
} catch (e) {
  console.log('  ⚠️ .env 文件读取失败（不影响启动）:', e.message);
}

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_MODEL  = 'deepseek-v4-flash';
// ====================================

if (!API_KEY) {
  console.log('\n  ⚠️  警告：未设置 DEEPSEEK_API_KEY 环境变量');
  console.log('       AI 功能将无法使用，但页面仍可正常展示。\n');
}

const PORT = 3000;
const MAX_AGENT_ITERATIONS = 8;

// ====== Agent 提示词 ======
const AGENT_SYSTEM_PROMPT = `你是一名职业发展顾问 Agent。用户会给你一段招聘JD（岗位职责+任职要求），你的任务是帮应届生把JD里的能力要求转化为可以立刻动手做的作品集项目建议。

工作流程：
1. 先分析JD，提取出恰好3个最核心的能力要求，优先来自"任职要求"部分。
2. 对每个能力点，使用 search_github 工具搜索相关的开源项目作为参考（每次搜索用不同的英文关键词）。
3. 如果某个能力点涉及数据分析、机器学习、用户行为研究等，可以尝试使用 search_datasets 工具搜索可用的公开数据集。
4. 基于搜索到的真实资源，用自然语言生成3个具体的项目建议总结。

重要规则：
- 每个项目建议要具体到今天就能开始写第一行代码，不能是空泛表述。
- 优先使用 GitHub 搜索结果，数据集是可选补充。
- 如果某个工具（尤其是 search_datasets）连续2次返回错误或超时，请放弃使用该工具，基于已有的 GitHub 资源继续生成建议，不要反复重试浪费轮次。
- 必须引用你搜到的真实 GitHub 项目（名称、链接）。
- 说明为什么这个项目能证明该能力。
- 给出预估完成时间。
- 默认用户是应届生、零项目经验的求职者。
- 严格控制迭代次数，最多使用4轮工具调用就要进入总结阶段。

输出格式：用自然语言分段输出3个项目建议，不要输出JSON。每个项目包含：能力名称、JD原文引用、项目名称、具体做法、参考资源、为什么能证明、预估时间。`;

const JSON_FORMAT_PROMPT = `请把下面的项目建议总结，整理成严格的JSON数组格式。不要有任何前言、解释或markdown代码块标记，只输出JSON数组本身。

JSON数组中每个对象包含这些字段：
- skill: 能力名称
- jd_quote: JD原文节选（30字以内）
- project_title: 项目名称
- project_brief: 具体做什么，产出什么形式，要详细具体
- why_it_proves: 为什么这个项目能证明该能力（1-2句话）
- estimated_time: 预估耗时（如"1天"、"2-3天"）
- references: 数组，每个元素包含 name（资源名称）、url（链接）、type（"github"或"dataset"）

必须恰好输出3个项目建议。`;

// ====== Agent 工具定义 ======
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_github',
      description: 'Search GitHub for open-source projects related to a skill or keyword. Returns real repos with stars, descriptions, and URLs.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Search keyword in English, e.g. "data visualization dashboard python"' }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_datasets',
      description: 'Search Hugging Face for public datasets that can be used in projects. Returns real datasets with download counts.',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: 'Search keyword in English, e.g. "product reviews" or "user behavior"' }
        },
        required: ['keyword']
      }
    }
  }
];

// ====== 工具执行函数 ======
function searchGitHub(keyword) {
  return new Promise((resolve) => {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(keyword)}&sort=stars&per_page=5`;
    const req = https.get(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Transit-Agent'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const json = JSON.parse(raw);
          const repos = (json.items || []).slice(0, 5).map(r => ({
            name: r.full_name,
            stars: r.stargazers_count,
            description: (r.description || '').substring(0, 160),
            url: r.html_url,
            language: r.language || ''
          }));
          resolve(JSON.stringify(repos));
        } catch (e) {
          resolve(JSON.stringify({ error: 'parse failed', raw: raw.substring(0, 200) }));
        }
      });
    });
    req.on('error', (e) => {
      resolve(JSON.stringify({ error: e.message }));
    });
    req.setTimeout(10000, () => {
      req.destroy();
      resolve(JSON.stringify({ error: 'timeout' }));
    });
  });
}

function searchDatasets(keyword) {
  return new Promise((resolve) => {
    const url = `https://huggingface.co/api/datasets?search=${encodeURIComponent(keyword)}&limit=3`;
    const req = https.get(url, {
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const json = JSON.parse(raw);
          const datasets = (json || []).slice(0, 3).map(d => ({
            id: d.id,
            downloads: d.downloads || 0,
            likes: d.likes || 0,
            url: `https://huggingface.co/datasets/${d.id}`
          }));
          resolve(JSON.stringify(datasets));
        } catch (e) {
          resolve(JSON.stringify({ error: 'parse failed' }));
        }
      });
    });
    req.on('error', (e) => {
      resolve(JSON.stringify({ error: e.message }));
    });
    req.setTimeout(20000, () => {
      req.destroy();
      resolve(JSON.stringify({ error: 'timeout' }));
    });
  });
}

async function executeTool(name, args) {
  if (name === 'search_github') return await searchGitHub(args.keyword);
  if (name === 'search_datasets') return await searchDatasets(args.keyword);
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

// ====== DeepSeek API 调用 (Promise 封装) ======
function callDeepSeek(messages, temperature, tools) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: API_MODEL,
      messages,
      temperature: temperature ?? 0.7,
      ...(tools ? { tools, tool_choice: 'auto' } : {})
    });

    const targetUrl = new URL(API_BASE_URL.replace(/\/$/, '') + '/chat/completions');
    const isHttps = targetUrl.protocol === 'https:';
    const mod = isHttps ? https : http;

    const req = mod.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message || JSON.stringify(json.error)));
            return;
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`API 返回解析失败: ${data.substring(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('API 请求超时 (60s)'));
    });
    req.write(body);
    req.end();
  });
}

// ====== SSE 辅助 ======
function sendSSE(res, type, data) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

// ====== HTTP 服务器 ======
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- 状态检查 ----
  if (req.method === 'GET' && req.url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ configured: !!API_KEY }));
    return;
  }

  // ---- Agent 端点 (SSE 流式) ----
  if (req.method === 'POST' && req.url === '/api/agent') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { userContent, temperature } = JSON.parse(body);

        if (!API_KEY) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: '服务器未配置 API_KEY' } }));
          return;
        }

        // SSE headers
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        // ====== 第一阶段：Agent 循环搜索资源并生成自然语言总结 ======
        let conversation = [
          { role: 'system', content: AGENT_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ];
        let iterations = 0;
        let agentSummary = null;

        while (iterations < MAX_AGENT_ITERATIONS) {
          iterations++;

          const response = await callDeepSeek(conversation, temperature, TOOLS);
          const msg = response.choices[0].message;

          // 模型决定调用工具
          if (msg.tool_calls && msg.tool_calls.length > 0) {
            // 发送思考事件
            if (msg.content) {
              sendSSE(res, 'thinking', { content: msg.content });
            }

            // 把 assistant 消息（含 tool_calls）加入对话
            conversation.push({
              role: 'assistant',
              content: msg.content || '',
              tool_calls: msg.tool_calls
            });

            // 逐个执行工具
            for (const tc of msg.tool_calls) {
              const toolName = tc.function.name;
              let toolArgs;
              try {
                toolArgs = JSON.parse(tc.function.arguments);
              } catch (e) {
                toolArgs = { keyword: tc.function.arguments };
              }

              // 发送 tool_call 事件
              sendSSE(res, 'tool_call', {
                id: tc.id,
                name: toolName,
                args: toolArgs
              });

              // 执行工具
              const result = await executeTool(toolName, toolArgs);

              // 发送 tool_result 事件
              let parsed;
              try { parsed = JSON.parse(result); } catch (e) { parsed = result; }
              sendSSE(res, 'tool_result', {
                id: tc.id,
                name: toolName,
                result: parsed
              });

              // 把工具结果加入对话
              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result
              });
            }
            // 循环继续，让模型决定下一步
          } else {
            // 模型返回自然语言总结
            agentSummary = msg.content;
            sendSSE(res, 'thinking', { content: '资源搜索完成，正在整理最终建议...' });
            break;
          }
        }

        if (!agentSummary) {
          sendSSE(res, 'error', { message: 'Agent 思考轮次超限，请重试' });
          res.end();
          return;
        }

        // ====== 第二阶段：把自然语言总结格式化为严格 JSON ======
        sendSSE(res, 'thinking', { content: '正在格式化输出...' });

        const formatMessages = [
          { role: 'system', content: JSON_FORMAT_PROMPT },
          { role: 'user', content: agentSummary }
        ];

        let finalJsonText = null;
        let parseError = null;

        try {
          const formatResponse = await callDeepSeek(formatMessages, 0.3, null);
          finalJsonText = formatResponse.choices[0].message.content.trim();

          // 验证 JSON
          if (finalJsonText.startsWith('```')) {
            finalJsonText = finalJsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          }
          JSON.parse(finalJsonText);
        } catch (e) {
          parseError = e.message;
        }

        // 如果 JSON 解析失败，尝试一次修复
        if (parseError) {
          sendSSE(res, 'thinking', { content: '输出格式有误，正在修复...' });
          const repairMessages = [
            { role: 'system', content: '请把以下内容修复为合法的JSON数组。只输出JSON数组本身，不要任何解释。' },
            { role: 'user', content: agentSummary + '\n\n之前的输出解析失败，错误：' + parseError }
          ];
          try {
            const repairResponse = await callDeepSeek(repairMessages, 0.3, null);
            finalJsonText = repairResponse.choices[0].message.content.trim();
            if (finalJsonText.startsWith('```')) {
              finalJsonText = finalJsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
            }
            JSON.parse(finalJsonText); // 验证
            parseError = null;
          } catch (e) {
            parseError = e.message;
          }
        }

        if (parseError) {
          sendSSE(res, 'error', { message: '无法解析 Agent 输出为 JSON: ' + parseError });
          res.end();
          return;
        }

        sendSSE(res, 'final', { content: finalJsonText });
        res.end();
      } catch (err) {
        sendSSE(res, 'error', { message: err.message || '未知错误' });
        res.end();
      }
    });
    return;
  }

  // ---- 兼容旧 API (非 Agent 模式) ----
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      (async () => {
        try {
          const { messages, temperature } = JSON.parse(body);
          if (!API_KEY) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: { message: '服务器未配置 API_KEY' } }));
            return;
          }
          const response = await callDeepSeek(messages, temperature, null);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(response));
        } catch (err) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
      })();
    });
    return;
  }

  // ---- 简历上传（PDF/Word） ----
  if (req.method === 'POST' && req.url === '/api/upload-resume') {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 15 * 1024 * 1024) { // base64 编码后约 15MB 上限
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', async () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '文件过大，请上传 10MB 以下的文件' }));
        return;
      }
      try {
        const { filename, mimetype, data } = JSON.parse(body);
        if (!data) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: '文件数据为空' }));
          return;
        }

        const buffer = Buffer.from(data, 'base64');
        let text = '';

        const isPDF = mimetype === 'application/pdf' || (filename || '').toLowerCase().endsWith('.pdf');
        const isDOCX = mimetype.includes('wordprocessingml') || (filename || '').toLowerCase().endsWith('.docx');
        const isDOC = (filename || '').toLowerCase().endsWith('.doc');

        if (isPDF) {
          if (!PDFParse) {
            throw new Error('服务器未安装 pdf-parse 模块');
          }
          const parser = new PDFParse({ data: buffer });
          const result = await parser.getText();
          text = result.text;
        } else if (isDOCX) {
          if (!mammoth) {
            throw new Error('服务器未安装 mammoth 模块');
          }
          const result = await mammoth.extractRawText({ buffer });
          text = result.value;
        } else if (isDOC) {
          throw new Error('.doc 格式不支持，请转换为 .docx 或 PDF 后上传');
        } else {
          throw new Error('不支持的文件格式，仅支持 PDF / DOCX');
        }

        // 清理文本
        text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

        if (!text || text.length < 10) {
          throw new Error('文件内容提取失败，可能是扫描件或空文件');
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, text: text.substring(0, 20000) }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: err.message || '文件解析失败' }));
      }
    });
    return;
  }

  // ---- 静态文件 ----
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0];
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const status = API_KEY ? '\u2705 API \u5df2\u914d\u7f6e' : '\u26a0\ufe0f  API \u672a\u914d\u7f6e';
  console.log('');
  console.log('  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('  \u2551  Transit (Agent Mode)               \u2551');
  console.log('  \u2551                                      \u2551');
  console.log(`  \u2551  http://localhost:${PORT}              \u2551`);
  console.log('  \u2551  Tools: GitHub + HuggingFace         \u2551');
  console.log('  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
  console.log(`  ${status}`);
  console.log('  \u6309 Ctrl+C \u505c\u6b62\u670d\u52a1\u3002\n');
});
