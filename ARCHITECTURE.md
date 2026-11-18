# News Station — 繁中編輯試刊

Cloudflare Worker ESM，執行時無套件相依。手機首頁從 `/api/editions` 讀取已編輯的期刊；不再要求使用者自行準備 JSON 才有新聞。

- `content/editions.json`：含實際日期、截止時間與版本的編輯資料。每則包含繁中摘要、事實、逐項引用、判讀、限制、口播稿與更正紀錄。
- `worker/editorial.js`：候選篩選與編輯 schema 驗證。SDK 小版本預設移至技術參考，安全修補送待評估，明示贊助排除。
- `SOURCE-REGISTRY.yaml`：新聞來源清單，建置時驗證並嵌入 Worker。
- `worker/index.js`：私有站路由與來源擷取。來源獨立逾時與錯誤顯示，不使用平台 default cache。
- `web/app.js`：閱讀、分類、來源、收藏、已讀、備份。正式期刊可透過 Cedar 播報單則或逐篇連播。瀏覽器另提供裝置朗讀。
- `worker/neural-audio.js` 透過 OpenAI Realtime 合成已發布的編輯口播稿，取得 Cedar 音色確認並核對逐字稿後輸出 WAV。
- `build.mjs`：驗證期刊、檢查前端語法並嵌入單一 Worker ESM。
- `scripts/add-edition.mjs`：加入新的合格期刊；拒絕沒有新增事實的同日事件重報。

官方聲明與獨立證實有不同狀態；本次五則為核對過的一手公告，沒有宣稱第三方驗證成效。

未接通：摘要模型 API、自動查證、無人值守晨晚報、SQLite/FTS5、跨裝置同步、獨立補漏、Google Drive 歸檔與音檔的 72 小時定期清理。Service worker 不做離線內容快取。
