// api/search-food.js
// Vercel 서버리스 함수: 브라우저 대신 서버에서 식약처 식품영양성분DB(I2790)를 호출해 CORS 문제를 우회합니다.
// 필요한 환경변수: MFDS_API_KEY (Vercel 프로젝트 설정 > Environment Variables 에 등록)

export default async function handler(req, res) {
  const q = (req.query.q || '').toString().trim();

  if (!q) {
    res.status(400).json({ error: '검색어(q)가 필요합니다.' });
    return;
  }

  const apiKey = process.env.MFDS_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'MFDS_API_KEY 환경변수가 설정되지 않았습니다.' });
    return;
  }

  // I2790: 식품영양성분DB, DESC_KOR: 식품명 검색, NUTR_CONT1: 열량(kcal)
  const url = `https://openapi.foodsafetykorea.go.kr/api/${apiKey}/I2790/json/1/20/DESC_KOR=${encodeURIComponent(q)}`;

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(502).json({ error: '식약처 API 응답 오류', status: upstream.status });
      return;
    }
    const data = await upstream.json();

    const rows = data?.I2790?.row;
    if (!Array.isArray(rows)) {
      // 결과 없음 (식약처 API는 결과가 없으면 다른 형태의 응답을 줌)
      res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
      res.status(200).json({ results: [] });
      return;
    }

    const results = rows
      .map((r) => ({
        name: r.DESC_KOR || '',
        kcal: Math.round(parseFloat(r.NUTR_CONT1) || 0),
        servingSize: r.SERVING_SIZE || null,
        maker: r.MAKER_NAME || null,
        group: r.GROUP_NAME || null,
      }))
      .filter((r) => r.name);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ results });
  } catch (e) {
    res.status(500).json({ error: '서버 오류', message: e.message });
  }
}
