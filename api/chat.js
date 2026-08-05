/**
 * Screen AI 诊断 — Vercel Serverless Function
 * POST /api/chat
 * 
 * 环境变量：DEEPSEEK_API_KEY
 */
const API_BASE_URL = 'https://api.deepseek.com/v1';
const API_MODEL = 'deepseek-chat';

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: { message: 'DEEPSEEK_API_KEY 环境变量未配置' } });
    return;
  }

  try {
    // Vercel 自动解析 JSON body
    const { messages, temperature } = req.body;

    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: { message: 'messages 参数无效' } });
      return;
    }

    const response = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: API_MODEL,
        messages,
        temperature: temperature ?? 0.3
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      let errMsg = `API ${response.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errMsg;
      } catch (e) {
        errMsg = errText.substring(0, 300);
      }
      res.status(502).json({ error: { message: errMsg } });
      return;
    }

    const data = await response.json();

    if (data.error) {
      res.status(502).json({ error: { message: data.error.message || 'API error' } });
      return;
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: { message: err.message || '请求失败' } });
  }
};
