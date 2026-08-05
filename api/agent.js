/**
 * Transit Agent SSE — Vercel Edge Function
 * POST /api/agent
 *
 * Edge Function 支持流式响应，无 10 秒超时限制
 * 环境变量：DEEPSEEK_API_KEY
 */
export const config = { runtime: 'edge' };

const API_BASE_URL = 'https://api.deepseek.com/v1';
const API_MODEL = 'deepseek-chat';
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

// ====== DeepSeek API 调用 ======
async function callDeepSeek(messages, temperature, tools) {
  const body = {
    model: API_MODEL,
    messages,
    temperature: temperature ?? 0.7,
    ...(tools ? { tools, tool_choice: 'auto' } : {})
  };

  const response = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    let errMsg = `DeepSeek API ${response.status}`;
    try {
      const errJson = JSON.parse(errText);
      errMsg = errJson.error?.message || errMsg;
    } catch (e) {
      errMsg = errText.substring(0, 300);
    }
    throw new Error(errMsg);
  }

  return response.json();
}

// ====== 工具执行函数 ======
async function searchGitHub(keyword) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(keyword)}&sort=stars&per_page=5`;
  try {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Transit-Agent'
      },
      signal: AbortSignal.timeout(10000)
    });
    const json = await response.json();
    const repos = (json.items || []).slice(0, 5).map(r => ({
      name: r.full_name,
      stars: r.stargazers_count,
      description: (r.description || '').substring(0, 160),
      url: r.html_url,
      language: r.language || ''
    }));
    return JSON.stringify(repos);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

async function searchDatasets(keyword) {
  const url = `https://huggingface.co/api/datasets?search=${encodeURIComponent(keyword)}&limit=3`;
  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
    const json = await response.json();
    const datasets = (json || []).slice(0, 3).map(d => ({
      id: d.id,
      downloads: d.downloads || 0,
      likes: d.likes || 0,
      url: `https://huggingface.co/datasets/${d.id}`
    }));
    return JSON.stringify(datasets);
  } catch (e) {
    return JSON.stringify({ error: e.message });
  }
}

async function executeTool(name, args) {
  if (name === 'search_github') return await searchGitHub(args.keyword);
  if (name === 'search_datasets') return await searchDatasets(args.keyword);
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

// ====== Edge Function 入口 ======
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { userContent, temperature } = await req.json();

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'DEEPSEEK_API_KEY not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendSSE = (type, data) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
      };

      try {
        // ====== 第一阶段：Agent 循环 ======
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

          if (msg.tool_calls && msg.tool_calls.length > 0) {
            if (msg.content) {
              sendSSE('thinking', { content: msg.content });
            }

            conversation.push({
              role: 'assistant',
              content: msg.content || '',
              tool_calls: msg.tool_calls
            });

            for (const tc of msg.tool_calls) {
              const toolName = tc.function.name;
              let toolArgs;
              try {
                toolArgs = JSON.parse(tc.function.arguments);
              } catch (e) {
                toolArgs = { keyword: tc.function.arguments };
              }

              sendSSE('tool_call', { id: tc.id, name: toolName, args: toolArgs });

              const result = await executeTool(toolName, toolArgs);

              let parsed;
              try { parsed = JSON.parse(result); } catch (e) { parsed = result; }
              sendSSE('tool_result', { id: tc.id, name: toolName, result: parsed });

              conversation.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result
              });
            }
          } else {
            agentSummary = msg.content;
            sendSSE('thinking', { content: '资源搜索完成，正在整理最终建议...' });
            break;
          }
        }

        if (!agentSummary) {
          sendSSE('error', { message: 'Agent 思考轮次超限，请重试' });
          controller.close();
          return;
        }

        // ====== 第二阶段：JSON 格式化 ======
        sendSSE('thinking', { content: '正在格式化输出...' });

        const formatMessages = [
          { role: 'system', content: JSON_FORMAT_PROMPT },
          { role: 'user', content: agentSummary }
        ];

        let finalJsonText = null;
        let parseError = null;

        try {
          const formatResponse = await callDeepSeek(formatMessages, 0.3, null);
          finalJsonText = formatResponse.choices[0].message.content.trim();

          if (finalJsonText.startsWith('```')) {
            finalJsonText = finalJsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
          }
          JSON.parse(finalJsonText);
        } catch (e) {
          parseError = e.message;
        }

        // JSON 修复尝试
        if (parseError) {
          sendSSE('thinking', { content: '输出格式有误，正在修复...' });
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
            JSON.parse(finalJsonText);
            parseError = null;
          } catch (e) {
            parseError = e.message;
          }
        }

        if (parseError) {
          sendSSE('error', { message: '无法解析 Agent 输出为 JSON: ' + parseError });
          controller.close();
          return;
        }

        sendSSE('final', { content: finalJsonText });
        controller.close();
      } catch (err) {
        sendSSE('error', { message: err.message || '未知错误' });
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
