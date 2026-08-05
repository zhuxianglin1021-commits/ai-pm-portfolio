/**
 * 状态检查 — Vercel Serverless Function
 * GET /api/status
 */
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ configured: !!process.env.DEEPSEEK_API_KEY });
};
