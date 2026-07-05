// netlify/functions/trends.js
// Proxy per Google Trends (API non ufficiale, la stessa usata da pytrends).
// Flusso: cookie NID → /api/explore (ottiene token TIMESERIES) → /api/widgetdata/multiline
// Le risposte Google iniziano con `)]}',` : va rimosso prima del JSON.parse.

const LEADERS = [
  'Giorgia Meloni',
  'Elly Schlein',
  'Giuseppe Conte',
  'Matteo Salvini',
  'Antonio Tajani',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function stripPrefix(text) {
  const i = text.indexOf('{');
  if (i < 0) throw new Error('Risposta Google non riconosciuta');
  return JSON.parse(text.slice(i));
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    // cache CDN 1h: riduce drasticamente il rischio di 429 da Google
    'Cache-Control': 'public, max-age=3600, s-maxage=3600',
  };

  try {
    const qs = event.queryStringParameters || {};
    const time = qs.time || 'today 3-m'; // ultimi 90 giorni, granularità giornaliera
    const kws = (qs.kw ? qs.kw.split('|') : LEADERS).slice(0, 5); // Trends: max 5 termini

    // 1) cookie NID (senza, explore spesso risponde 429)
    let cookie = '';
    try {
      const home = await fetch('https://trends.google.com/?geo=IT', {
        headers: { 'User-Agent': UA },
      });
      const sc = home.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
    } catch (_) {
      /* si tenta comunque senza cookie */
    }

    const gHeaders = { 'User-Agent': UA, Cookie: cookie };

    // 2) explore → token del widget TIMESERIES
    const req = {
      comparisonItem: kws.map((keyword) => ({ keyword, geo: 'IT', time })),
      category: 0,
      property: '',
    };
    const exploreUrl =
      'https://trends.google.com/trends/api/explore?hl=it&tz=-120&req=' +
      encodeURIComponent(JSON.stringify(req));
    const expRes = await fetch(exploreUrl, { headers: gHeaders });
    if (expRes.status === 429) {
      throw new Error('Google ha limitato le richieste (429): riprova tra qualche minuto');
    }
    if (!expRes.ok) throw new Error('Explore fallito: HTTP ' + expRes.status);
    const explore = stripPrefix(await expRes.text());
    const widget = (explore.widgets || []).find((w) => w.id === 'TIMESERIES');
    if (!widget) throw new Error('Widget TIMESERIES assente nella risposta');

    // 3) widgetdata/multiline → serie temporale
    const dataUrl =
      'https://trends.google.com/trends/api/widgetdata/multiline?hl=it&tz=-120&req=' +
      encodeURIComponent(JSON.stringify(widget.request)) +
      '&token=' + widget.token;
    const dataRes = await fetch(dataUrl, { headers: gHeaders });
    if (!dataRes.ok) throw new Error('Widgetdata fallito: HTTP ' + dataRes.status);
    const data = stripPrefix(await dataRes.text());
    const timeline = (data.default && data.default.timelineData) || [];

    const series = kws.map((keyword, i) => ({
      keyword,
      points: timeline
        .filter((p) => Array.isArray(p.value) && p.value[i] !== undefined)
        .map((p) => ({ t: parseInt(p.time, 10) * 1000, v: p.value[i] })),
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ series }) };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
