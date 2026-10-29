"use strict";

const { timingSafeEqual } = require("node:crypto");

/**
 * Vercel Cron 每天呼叫此 API，藉由 Deploy Hook 觸發完整 Production Build：
 * CWA -> scripts/build-database.js -> SQLite validation -> /api/weather。
 *
 * 注意：Serverless 的本地檔案系統不是持久化資料庫，因此不能直接在
 * 這個 Runtime Function 內覆寫 weather.db；必須重新部署才能更新 SQLite。
 */
function matchesCronSecret(authorization, secret) {
  if (typeof authorization !== "string" || !secret) return false;
  const received = Buffer.from(authorization);
  const expected = Buffer.from("Bearer " + secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function validDeployHook(value) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "api.vercel.com" &&
      url.username === "" &&
      url.password === "" &&
      /^\/v1\/integrations\/deploy\/[^/]+\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

module.exports = async function refreshWeather(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "Method Not Allowed" });
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[RideSky Cron] CRON_SECRET is missing.");
    return res.status(503).json({ success: false, message: "排程尚未完成安全設定" });
  }

  if (!matchesCronSecret(req.headers.authorization, cronSecret)) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  // 避免有人在 Preview 環境誤用 Production 的 Deploy Hook。
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    return res.status(403).json({ success: false, message: "此排程只允許在 Production 執行" });
  }

  const deployHook = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!validDeployHook(deployHook)) {
    console.error("[RideSky Cron] VERCEL_DEPLOY_HOOK_URL is missing or invalid.");
    return res.status(503).json({ success: false, message: "Vercel Deploy Hook 尚未設定" });
  }

  try {
    const response = await fetch(deployHook, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { "Accept": "application/json" }
    });

    // Vercel Deploy Hook 只表示「已建立建置工作」，不等於部署完成。
    if (!response.ok) {
      console.error("[RideSky Cron] Deploy Hook rejected the request. HTTP", response.status);
      return res.status(502).json({
        success: false,
        message: "Vercel 未接受重新部署要求",
        upstreamStatus: response.status
      });
    }

    const result = await response.json().catch(() => null);
    if (!result || !result.job || !result.job.id) {
      console.error("[RideSky Cron] Deploy Hook returned an unexpected response.");
      return res.status(502).json({
        success: false,
        message: "Vercel Deploy Hook 回覆格式不符合預期"
      });
    }

    console.info("[RideSky Cron] New production rebuild queued:", result.job.id);
    return res.status(202).json({
      success: true,
      status: "queued",
      message: "已請 Vercel 重新建置 CWA → SQLite；請至 Deployments 查看完成結果"
    });
  } catch (error) {
    // 避免把可能帶有憑證的 Deploy Hook URL 寫進 Logs。
    console.error("[RideSky Cron] Failed to request production rebuild:", error?.name || "NetworkError");
    return res.status(502).json({
      success: false,
      message: "無法連線至 Vercel Deploy Hook"
    });
  }
};
