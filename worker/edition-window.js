const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});

const DAY = 86_400_000;

export function taipeiDate(time = Date.now()) {
  return taipeiFormatter.format(time);
}

export function editionWindow(edition, date) {
  if (!['morning', 'evening'].includes(edition)) throw Error('Edition must be morning or evening.');
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw Error('Expected a Taipei date as YYYY-MM-DD.');
  const midnight = Date.parse(date + 'T00:00:00+08:00');
  if (!Number.isFinite(midnight) || taipeiDate(midnight) !== date) throw Error('Invalid Taipei date.');
  const morning = midnight + 7 * 3_600_000;
  const evening = midnight + (16 * 60 + 30) * 60_000;
  return {
    edition, date,
    start: new Date(edition === 'morning' ? evening - DAY : morning).toISOString(),
    end: new Date(edition === 'morning' ? morning : evening).toISOString(),
  };
}

// A pre-dawn click still updates the preceding day's evening slot.
export function latestDueWindow(time = Date.now()) {
  const date = taipeiDate(time);
  const evening = editionWindow('evening', date);
  if (time >= Date.parse(evening.end)) return evening;
  const morning = editionWindow('morning', date);
  if (time >= Date.parse(morning.end)) return morning;
  return editionWindow('evening', taipeiDate(time - DAY));
}
