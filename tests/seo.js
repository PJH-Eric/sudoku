'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { inject, validate } = require('../scripts/inject-seo');
const root = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'seo.config.json'), 'utf8'));
const source = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
validate(cfg);
assert.ok(source.includes('<!--SEO:HEAD-->'));
const dicts = {};
const i18n = { register(lang, values) { Object.assign(dicts[lang] || (dicts[lang] = {}), values); return i18n; } };
const localeBox = { I18N: i18n };
localeBox.window = localeBox;
localeBox.self = localeBox;
vm.runInNewContext(fs.readFileSync(path.join(root, 'public/js/locales.js'), 'utf8'), localeBox);
const titleKey = source.match(/data-i18n-title="([^"]+)"/)[1];
const descKey = source.match(/<meta\b(?=[^>]*name="description")[^>]*data-i18n-content="([^"]+)"/)[1];
assert.equal(dicts['zh-Hant'][titleKey], cfg.title, '繁中標題必須與 SEO 設定一致');
assert.equal(dicts['zh-Hant'][descKey], cfg.description, '繁中說明必須與 SEO 設定一致');
assert.ok(dicts.en[titleKey] && dicts.en[descKey], '英文 metadata 必須完整');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'game-seo-'));
try {
  fs.mkdirSync(path.join(temp, 'public'));
  fs.writeFileSync(path.join(temp, 'seo.config.json'), JSON.stringify(cfg), 'utf8');
  fs.writeFileSync(path.join(temp, 'public/index.html'), source, 'utf8');
  inject(temp, {});
  const built = fs.readFileSync(path.join(temp, 'public/index.html'), 'utf8');
  assert.equal((built.match(/name="description"/g) || []).length, 1);
  assert.equal((built.match(/rel="canonical"/g) || []).length, 1);
  assert.ok(built.includes('href="' + cfg.siteUrl + '"'));
  assert.ok(built.includes('property="og:title"'));
  assert.ok(built.includes('name="twitter:card"'));
  const ld = JSON.parse(built.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld.url, cfg.siteUrl);
  if (cfg.ogImage) {
    assert.equal(ld.image, cfg.ogImage);
    assert.equal(ld.thumbnailUrl, cfg.ogImage);
    assert.ok(built.includes('property="og:image" content="' + cfg.ogImage + '"'));
    assert.ok(built.includes('property="og:image:type" content="image/webp"'));
    assert.ok(built.includes('property="og:image:width" content="1200"'));
    assert.ok(built.includes('property="og:image:height" content="675"'));
    assert.ok(built.includes('name="twitter:image" content="' + cfg.ogImage + '"'));
  }
  const sitemap = fs.readFileSync(path.join(temp, 'public/sitemap.xml'), 'utf8');
  assert.equal((sitemap.match(/<loc>/g) || []).length, 1);
  assert.ok(sitemap.includes(cfg.siteUrl));
  inject(temp, {});
  assert.equal(fs.readFileSync(path.join(temp, 'public/index.html'), 'utf8'), built, '注入必須可重複執行');
  fs.writeFileSync(path.join(temp, 'public/index.html'), '<title>test</title>', 'utf8');
  assert.throws(() => inject(temp, {}), /SEO:HEAD/);
  assert.throws(() => validate({ ...cfg, siteUrl: cfg.siteUrl.slice(0, -1) }), /siteUrl/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log('SEO metadata injection verified');
