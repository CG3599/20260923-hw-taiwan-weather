import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

export default async function handler(req, res) {
  const dbPath = path.join(process.cwd(), "database", "weather.db");

  if (!fs.existsSync(dbPath)) {
    return res.status(503).json({
      success: false,
      message: "SQLite 資料庫尚未建立，請重新部署以執行資料庫建置流程。"
    });
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma("foreign_keys = ON");

    // SQLite 只負責提供資料；7 日日期切分由 Node.js 以台灣 UTC+8 明確處理，避免 SQLite 時區函式在部署環境產生差異。
    const allRows = db.prepare(`
      SELECT
        l.city,
        l.town,
        l.latitude,
        l.longitude,
        wf.forecast_time,
        wf.temperature,
        wf.humidity,
        wf.precipitation_probability AS pop,
        wf.weather,
        wf.wind_direction,
        wf.wind_speed
      FROM weather_forecasts wf
      JOIN locations l ON l.id = wf.location_id
      ORDER BY l.city, l.town, wf.forecast_time
    `).all();

    const taiwanDate = value => {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return null;
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(d);
    };

    const dates = [...new Set(allRows.map(row => taiwanDate(row.forecast_time)).filter(Boolean))].sort();
    if (!dates.length) {
      return res.status(500).json({
        success: false,
        message: "SQLite 沒有可用的預報日期",
        validation: {
          location_count: new Set(allRows.map(row => row.city + "||" + row.town)).size,
          forecast_count: allRows.length,
          forecast_day_count: 0
        }
      });
    }

    // 日期窗口必須以台灣本地日曆日為準。
    // 舊版使用 dates.slice(-7)，等於「永遠拿資料庫裡最新的 7 天」；
    // 當 CWA 晚間更新並多出更後面的預報日時，今天可能在 20:00 左右就被擠出窗口，
    // 前端因此誤以為已經跨日。現在只有 Asia/Taipei 真正到 00:00 才會換成隔天。
    const todayTaiwan = taiwanDate(new Date());
    const selectedDateList = dates.filter(date => date >= todayTaiwan).slice(0, 7);

    // CWA 的一週預報在不同更新時段，可能暫時只涵蓋今日起 5～6 個台灣日曆日。
    // 這不代表資料無效，因此不再因「未滿完整 7 日」讓整支 API 回 500。
    // 只要今日起仍有可用預報，就回傳實際可用日期（最多 7 天）。
    if (!selectedDateList.length) {
      return res.status(500).json({
        success: false,
        message: "SQLite 預報資料沒有台灣今日起可用的日期",
        validation: {
          today_taiwan: todayTaiwan,
          available_dates: dates,
          selected_dates: selectedDateList
        }
      });
    }

    const selectedDates = new Set(selectedDateList);
    const rows = allRows.filter(row => selectedDates.has(taiwanDate(row.forecast_time)));

    const validation = {
      location_count: new Set(rows.map(row => row.city + "||" + row.town)).size,
      forecast_count: rows.length,
      forecast_day_count: new Set(rows.map(row => taiwanDate(row.forecast_time)).filter(Boolean)).size,
      min_forecast_date: [...selectedDates].sort()[0] || null,
      max_forecast_date: [...selectedDates].sort().at(-1) || null
    };

    if (
      validation.location_count !== 368 ||
      validation.forecast_count === 0 ||
      validation.forecast_day_count !== selectedDateList.length
    ) {
      return res.status(500).json({
        success: false,
        message: "SQLite 預報資料驗證失敗",
        validation
      });
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      success: true,
      source: "SQLite",
      sql: "weather_forecasts JOIN locations + 以 Asia/Taipei 今日 00:00 為基準取得今日起最多 7 個可用日曆日",
      records: {
        Locations: rows
      },
      meta: {
        locationCount: validation.location_count,
        forecastCount: validation.forecast_count,
        forecastDayCount: validation.forecast_day_count,
        minForecastDate: validation.min_forecast_date,
        maxForecastDate: validation.max_forecast_date,
        todayTaiwan,
        forecastDates: selectedDateList,
        validation
      }
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: "SQLite 查詢失敗",
      error: String(error)
    });
  } finally {
    if (db) db.close();
  }
}
