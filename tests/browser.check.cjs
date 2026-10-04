/* Validação de layout e interações com dados locais, sem usar a chave do TMDB. */
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { chromium } = require('playwright');
const origin = process.env.STUDY_BASE_URL || 'http://127.0.0.1:8000';
const widths = [320, 360, 390, 600, 768, 1024, 1440];
const requests = [];

function items(type = 'movie', genre = 18) {
  return Array.from({ length: 20 }, (_, index) => ({
    id: 101 + index, media_type: type,
    title: 'História ' + (index + 1), name: 'História ' + (index + 1),
    overview: 'Uma história de teste para verificar o catálogo e suas interações.',
    backdrop_path: '/backdrop-' + (101 + index) + '.svg',
    poster_path: '/poster-' + (101 + index) + '.svg',
    release_date: '2024-01-01', first_air_date: '2024-01-01',
    vote_average: 8, genre_ids: [genre], adult: false
  }));
}

function artwork(path) {
  const portrait = path.includes('poster');
  const logo = path.includes('logo');
  const width = logo ? 600 : portrait ? 600 : 1280;
  const height = logo ? 150 : portrait ? 900 : 720;
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '"><rect width="100%" height="100%" fill="' + (logo ? '#ffffff00' : '#30445e') + '"/><text x="50%" y="50%" text-anchor="middle" fill="white" font-size="60">História de teste</text></svg>';
}

async function prepare(page) {
  await page.addInitScript(() => localStorage.setItem('stream-study:previews', 'false'));
  await page.route('https://api.themoviedb.org/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const type = path.includes('/tv') || path.includes('/trending/all') ? 'tv' : 'movie';
    const genre = Number(url.searchParams.get('with_genres')) || 18;
    requests.push({ path, genre });
    let body;
    const details = path.match(/\/(movie|tv)\/(\d+)$/);
    if (details) {
      body = {
        overview: 'Detalhes da história de teste.', runtime: 120, number_of_seasons: 2,
        genres: [{ id: genre, name: 'Drama' }], original_title: 'História original',
        credits: { cast: [{ name: 'Pessoa de teste' }] }, videos: { results: [] },
        images: { logos: [{ iso_639_1: 'pt', file_path: '/logo.svg' }] },
        content_ratings: { results: [{ iso_3166_1: 'BR', rating: '14' }] },
        release_dates: { results: [{ iso_3166_1: 'BR', release_dates: [{ certification: '14' }] }] },
        recommendations: { results: items(details[1]).slice(1, 7) }
      };
    } else body = { results: items(type, genre) };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('https://image.tmdb.org/**', route => route.fulfill({
    contentType: 'image/svg+xml', body: artwork(new URL(route.request().url()).pathname)
  }));
  await page.route('**/Netflix_2015_logo.svg', route => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="28"><text x="0" y="24" fill="#e50914" font-family="Arial" font-size="25" font-weight="bold">NETFLIX</text></svg>'
  }));
}

async function noOverflow(page, width, label) {
  const size = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }));
  assert.ok(size.document <= size.viewport + 1, label + ': rolagem horizontal em ' + width + 'px');
  for (const selector of ['.navbar .brand', '#searchToggle', '.profile-trigger', '#billPlayBtn', '#billInfoBtn']) {
    const locator = page.locator(selector);
    if (!await locator.isVisible()) continue;
    const box = await locator.boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= width + 1, label + ': controle fora da tela: ' + selector);
  }
}

async function navigate(page, view, width) {
  if (width <= 900) {
    await page.locator('#mobileNav').click();
    await page.locator('#mobileNavPanel [data-view="' + view + '"]').click();
    assert.equal(await page.locator('#mobileNav').getAttribute('aria-expanded'), 'false');
  } else await page.locator('.desktop-nav [data-view="' + view + '"]').click();
}

(async () => {
  const browser = await chromium.launch();
  mkdirSync('browser-artifacts', { recursive: true });
  let currentPage;
  try {
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      currentPage = page;
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await prepare(page);
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.getElementById('rows').getAttribute('aria-busy') === 'false');
      await page.waitForFunction(() => document.getElementById('billboard').classList.contains('has-logo'));
      await noOverflow(page, width, 'Página inicial');
      const source = await page.locator('#billPoster').evaluate(img => img.currentSrc);
      assert.ok(source.includes(width <= 600 ? '/poster-' : '/backdrop-'), 'Arte inadequada em ' + width);

      const rowTitle = await page.locator('.row-title').first().textContent();
      await page.locator('.row-link').first().click();
      assert.equal(await page.locator('#searchTitle').textContent(), rowTitle);
      assert.equal(await page.locator('#searchGrid .card').count(), 20);
      await page.locator('#collectionBack').click();
      assert.equal(await page.locator('#rows').isVisible(), true);

      await page.locator('#searchToggle').click();
      await page.locator('#searchInput').fill('História');
      await page.waitForFunction(() => document.getElementById('searchStatus').textContent.includes('títulos encontrados'));
      assert.equal(await page.locator('#searchGrid .card').count(), 20);
      await noOverflow(page, width, 'Busca');
      await page.locator('#searchInput').press('Escape');
      assert.equal(await page.locator('#rows').isVisible(), true);

      await navigate(page, 'tv', width);
      await page.locator('#genreFilter').selectOption('10759');
      await page.waitForFunction(() => document.getElementById('rows').getAttribute('aria-busy') === 'false'
        && document.querySelector('.row-title')?.textContent === 'Ação e aventura em destaque');
      assert.equal(await page.locator('.row').count(), 2);
      await noOverflow(page, width, 'Séries filtradas');

      await page.locator('.card-open').first().click();
      await page.locator('#titleDialog').waitFor({ state: 'visible' });
      await page.locator('#modalList').click();
      assert.equal(await page.locator('#modalList').getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Escape');
      await navigate(page, 'list', width);
      await page.waitForFunction(() => document.getElementById('rows').getAttribute('aria-busy') === 'false');
      assert.equal(await page.locator('#rows .card').count(), 1);
      await noOverflow(page, width, 'Minha lista');
      assert.deepEqual(errors, []);
      console.log('PASS: ' + width + 'px — layout, menu, coleção, busca, gêneros e lista');
      await page.close();
    }
    assert.ok(requests.some(request => request.path === '/3/discover/tv' && request.genre === 10759));
  } catch (error) {
    if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: 'browser-artifacts/failure.png', fullPage: true });
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
