// Fictional reports for reader, narration, and publication tests.
function edition(date, slot, count) {
  const id = date + '-' + slot + '-fixture';
  const time = date + (slot === 'morning' ? 'T07:00:00+08:00' : 'T17:30:00+08:00');
  const articles = Array.from({length: count}, (_, index) => {
    const station = '示範測站' + (index + 1);
    const storyId = id + '-story-' + (index + 1);
    const url = 'https://source.example/' + storyId;
    const facts = [station + '開始記錄水溫。', '量測資料每日公布一次。', '第一批資料涵蓋三個採樣點。'];
    return {
      id: storyId, event_id: storyId, status: 'edited', topic: '環境',
      title: station + '開始公布河川溫度量測結果',
      excerpt: station + '已發布第一批河川水溫資料，並公布測量頻率和涵蓋範圍。',
      facts, source: '測試來源', url, source_urls: [url], date: time, verified_at: time,
      verification_status: slot === 'morning' ? 'official_statement' : 'attributed_report',
      evidence: facts.map(fact => ({
        fact, url, support: '公告中明列的資料包含以下內容。' + fact,
        ...(slot === 'evening' ? {origin_id: storyId, review_state: 'original_read'} : {}),
      })),
      editorial_kind: 'news', newsworthiness: '讓民眾查閱河川環境的監測資料。',
      selection_reason: '資料涵蓋環境監測。', analysis: '可用來比較不同採樣點。',
      uncertainty: '資料仍在持續累積。', correction_history: [],
      speech_script: station + '開始公布河川水溫。第一批資料涵蓋三個採樣點，每日更新一次。測站也說明了觀測方法，後續會持續累積資料，讓公眾查閱。',
    };
  });
  return {id, date, edition: slot, timezone: 'Asia/Taipei', published_at: time, cutoff_at: time, articles};
}

export const editions = [
  edition('2026-11-17', 'morning', 5),
  edition('2026-11-18', 'evening', 9),
];
