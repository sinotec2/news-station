# News Station 新聞工作站

繁體中文晨晚報。首頁顯示最近出版的一期，可切換晨報、晚報、查閱各則新聞的原始來源，以及播放 Cedar 合成的編輯口播稿。程式使用 Node.js 建置為 Cloudflare Worker，也附本機閱讀與採集工具。

## 在自己的電腦開啟

使用 Node.js 24、npm 和 Git。晨晚報更新工具另需 Linux 的 `flock`（util-linux），Windows 可在 WSL 執行。以下指令假設目前目錄是專案根目錄。安裝套件需要連到 npm 公開套件庫。

```sh
npm ci
npm test
npm run validate:editorial
node scripts/preview.mjs
```

打開 `http://127.0.0.1:8787`。預覽只監聽本機、只接受讀取請求；期刊資料有變更時，重新整理頁面即可讀到新一期。需要其他埠號可設定 `PORT`。按 Ctrl+C 關閉。首次啟動和期刊更新會自動執行建置；單獨建置可用 `npm run build`，輸出為 `dist/server/index.js`。

本機預覽可讀隨附的期刊，也可在「來源工作區」手動擷取已啟用來源。預覽不讀 API 金鑰，裝置朗讀由瀏覽器提供。要用 Cedar，請在支援 Cloudflare Worker WebSocket 的環境啟用伺服器端金鑰。

## 建立獨立副本

原始碼位於私人 GitHub 儲存庫，需要讀取權限。可依儲存庫政策 fork 到自己的私人空間，再 clone 自己的副本。如果組織停用私人 fork，請所有者授權後複製到新的私人儲存庫。儲存庫目前沒有提供公開軟體授權。部署給其他讀者、公開散布或商用前，請確認程式的使用權與各媒體的內容條款。[私人儲存庫](https://github.com/sinotec2/news-station)

完成 fork 後，將下列 `YOUR_ACCOUNT` 換成副本所在的帳號或組織。

```sh
git clone https://github.com/YOUR_ACCOUNT/news-station.git
cd news-station
```

1. 在**新副本**執行 `git remote get-url origin`，確認它指向自己的 Git 儲存庫。要先在本機試跑，可從副本移除 `.openai/hosting.json`，或把內容改成 `{}`。建置和預覽均支援沒有 Sites 專案 ID 的情形。
2. 要上線，先建立自己的私人 Site，使用新 Site 配發的 project ID 和專屬的 Sites Git 遠端。在副本的 `.openai/hosting.json` 設定新 ID，再用該 Site 的建置及發布流程部署。保留僅自己或指定讀者可讀的權限。
3. 需要即時寫入期刊時，在新專案的 `.openai/hosting.json` 保留 `"r2": {"binding":"EDITION_BUCKET"}`。這個綁定由部署平台對應到該副本專用的私有儲存空間。本機預覽直接使用 `content/editions.json`。
4. 在新 Site 設定自己的伺服器端機密，再於作業機設定該站的接收網址與憑證。個人收藏與已讀紀錄由各站讀者的瀏覽器儲存。副本若要提供既有期刊給其他讀者，請先確認這些稿件的使用權。

### 環境變數

| 變數 | 設在哪裡 | 用途 |
| --- | --- | --- |
| `OPENAI_API_KEY` | 新 Site 的伺服器端 Secret | 選用。生成 Cedar 語音，用量歸該 API 金鑰所屬專案。 |
| `NEWS_STATION_URL` | 採集／出版作業機 | 選用。自己的正式站 HTTPS 來源網址。 |
| `EDITION_PUBLISH_TOKEN` | 新 Site 的伺服器端 Secret、獲授權的出版作業機 | 使用相同的專用隨機機密驗證期刊寫入。 |
| `SITES_ACCESS_TOKEN` | 採集／出版作業機 | 私人 Sites 入口的有效服務存取憑證，依平台有效期更新。 |

單純閱讀、測試、本機採集不需以上變數。有需要時可在自己的終端機執行 `umask 077` 再用 `cp .env.example .env` 建立個人設定。Git 已忽略 `.env`、`.dev.vars` 和本機產物。可用 Node 的 `--env-file=.env` 把設定載入指定作業。託管 Sites 則在該站的環境變數介面以機密值設定，依平台流程重新部署以套用。開啟 `/api/audio/status` 可檢查音色及金鑰設定狀態，實際播放才會要求合成。

## 手動更新與出刊

```sh
npm run update:morning
npm run update:evening
```

每次指令處理指定版次，日期依台北時區。晨報涵蓋前一日晚報截止後至當日 07:00；晚報涵蓋當日 07:00 後至 17:30。每次執行都留下 `.generated/edition-runs/YYYY-MM-DD-morning/report.json` 或對應的 `evening/report.json`，可查看結果與該次採集、選稿明細。重跑已出版的同一版次會傳回現有期刊。合格新聞可少於篇數上限，沒有合格稿件時會保留上一期。

手動更新來源與正式出刊用途不同。網頁的「重新擷取來源」更新候選列表；晨晚報指令會核對原文與編輯材料，將可出刊的結果寫入本機期刊檔。可用下列方式指定日期試跑、帶入已核對稿件，或把成功的正式結果發送到自己的站。

```sh
node scripts/update-edition.mjs evening --date YYYY-MM-DD --dry-run
node scripts/update-edition.mjs evening --date YYYY-MM-DD --reviewed /path/to/reviewed.json
node --env-file=.env scripts/publish-edition.mjs --report .generated/edition-runs/YYYY-MM-DD-evening/report.json
```

作業機與站點分開部署。直接部署 Worker 會帶入建置當下的期刊快照；設定 `EDITION_BUCKET` 與出版憑證後，更新作業可透過出版端點送入合格期刊，供首頁與歷史期刊讀取。儲存庫的 push 不會自行安裝排程。

## 晨晚排程

副本預設不啟用排程。需要定時執行時，將專案放在持續開機、有網路的作業機。先手動執行 `bash scripts/cron-edition.sh morning` 或 `bash scripts/cron-edition.sh evening`，這兩條也是排程中斷時的補跑入口。若要同步到網站，將上表的出版變數放入副本根目錄的私人 `.env`，或由作業機注入環境。腳本會載入該檔，設定了 `NEWS_STATION_URL` 時才會送出期刊並讀回核對。作業帳號需要本機期刊目錄的寫入權限。

下列範例使用支援 `CRON_TZ` 的 cron；安裝時把目錄改成自己的實際路徑，並確保 cron 的 PATH 包含 Node.js、npm 和 flock。

```cron
CRON_TZ=Asia/Taipei
0 7 * * * cd /srv/news-station && bash scripts/cron-edition.sh morning
30 17 * * * cd /srv/news-station && bash scripts/cron-edition.sh evening
```

若排程器固定使用 UTC，晨報用 `0 23 * * *`（台北日期的前一個 UTC 日），晚報用 `30 9 * * *`。排程時間是啟動採集的時間，實際發布取決於有無合格稿件及處理完成時間。

私人 Sites 的入口憑證有有效期。外部作業機長期自動投遞時，需由具權限的服務在執行前注入有效憑證。入口拒絕存取時，本機期刊和報告仍可讀；更新憑證後重跑同一版次即可補送。

## 來源與授權

`SOURCE-REGISTRY.yaml` 保存來源入口、抓取方式與適用狀態。新增來源可保持 `disabled_draft` 做技術試收。RSS 可讀性、原文是否符合編輯範圍、著作權授權需要分別確認。尤其中央社 RSS 的個人／非營利非商業條件，請依副本的實際讀者和用途核對。編輯稿保留來源署名與原文連結；轉載全文、圖片與音訊需要適用的授權。[中央社 RSS 使用說明](https://www.cna.com.tw/about/rss.aspx)

期刊欄位、審稿證據、逐站試收及音訊驗收分別見 [編輯規則](EDITORIAL.md)、[維運說明](OPERATIONS.md) 與 [Cedar 語音說明](NEURAL-AUDIO.md)。
