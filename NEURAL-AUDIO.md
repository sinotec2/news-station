# News Station / LuniHub 語音接入準備

## 目前完成與未完成

已實作 OpenAI Realtime 介面、完整新聞段落合成、逐字稿一致性檢查、WAV 封裝、音訊播放器與可選的共用物件儲存介面。未取得 API 金鑰，沒有產出真實 OpenAI 試音，不宣稱品質已驗收；沒有實際串接公司 LuniHub。

官方於 2026-10-01 公告舊 Speech API 模型將在 2027-01-06 停用，新接入依目前文件使用 gpt-realtime-2.1-mini / Realtime API；不能把這個模型名稱直接填到 /v1/audio/speech。

模型：gpt-realtime-2.1-mini；首選聲音：marin。實際中文口音、專有名詞與停頓須以試聽判斷。prompt 要求台灣華語、自然詞組、適當停頓與重音，逐字保留稿件的數字及限定語。若模型加字改寫，逐字稿檢查會拒絕音訊，可能需要調整稿件或合成方式；比對並不能代替人耳確認發音。

## API 與金鑰

- GET /api/audio/status：只回傳是否設定、模型、音色與儲存狀態，無秘密。
- POST /api/audio：只接受已發布 edition_id / article_id，不接受任意文字，不讓前端拿到金鑰；目前限同源私人站。回傳完整單則 WAV 與到期時間。
- OPENAI_API_KEY 只存 Sites runtime secret。依 Sites identity-and-secrets 技能，透過 OpenAI Developers 的 openai-platform-api-key 流程安全設定。不得放前端、Git、日誌或要求貼到對話。

沒有金鑰時顯示尚未接通，原本裝置朗讀明確標記為試用；不會默默降級卻宣稱已使用 OpenAI。

## 共用與資料生命週期

AUDIO_BUCKET 是可選的 R2 風格伺服器儲存介面（get / put / delete）。指紋包含口播稿、核對時間、更正、模型、聲音與指示；修改任一項即使用新音檔。到期音檔拒絕重用，讀取時刪除。瀏覽器不做離線持久快取；播放器物件到期後停止並釋放 URL。

目前未宣告／部署 AUDIO_BUCKET，狀態為 request_only；重播可能再次產生 API 用量。公司正式版還需要共用持久儲存、跨程序生成鎖、任務佇列、每天自動清理、用量限額與公司授權。單純 metadata 及讀取時清理不保證所有檔案在 72 小時自動實體刪除，不得在驗收中聲稱已完成此要求。

LuniHub 應透過公司後端授權讀取共用音訊，同一期的音檔可重用；不要讓每個員工帶自己的 API key，也不要靠私人 Sites 的登入當成公司 SSO。

## Business 訂閱與 API 額度

依 2026-11-16 查閱的官方規則，符合資格的付費 Business 工作區可由同時擁有 ChatGPT 工作區與 API 組織的擁有者啟用 API 額度福利；需相同帳號 email、付費訂閱至少 7 天，且受國家／開放範圍限制。每付費 Standard 席位月額度 20 美元、Premium 100 美元，工作區每月合計上限 500 美元；首次與年繳額度依官方規則計算。領取後仍以 API 組織的實際 Credit grants 為準，不因有 Business 席位就假設已領取。

官方來源：
- https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions
- https://developers.openai.com/api/docs/guides/chatgpt-api-credits
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/guides/realtime

## 試音驗收

以同一份 60–90 秒繁中新聞稿測試至少兩個聲音；包含日期、百分比、OpenAI、PFAS、碳權及草案等用語。檢查：語意停頓、過度重音、中英切換、數字與名稱、逐字一致性。通過單則後再聽完整晨報，檢查篇與篇之間的音量、語速與聲音一致。最後用 iPhone Safari／PWA 驗證背景、鎖屏、拖曳及續播。程式測試通過不等同聲音品質通過。
