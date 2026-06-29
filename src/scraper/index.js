const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const fs = require('fs');
const { urlToFolderName, ensureDir } = require('../utils');

chromium.use(StealthPlugin());

const RESULTS_DIR = process.env.RESULTS_DIR || './results';
const TIMEOUT = parseInt(process.env.TIMEOUT_MS) || 45000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function toAbsolute(href, baseUrl) {
  if (!href || href.startsWith('data:') || href.startsWith('javascript:')) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function cleanText(text) {
  return (text || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function attrHaystack($el) {
  const id = ($el.attr('id') || '').toLowerCase();
  const cls = ($el.attr('class') || '').toLowerCase();
  return `${id} ${cls}`;
}

function findSections($, keywords) {
  const matches = [];
  $('[id], [class]').each((_, el) => {
    const haystack = attrHaystack($(el));
    if (keywords.some((kw) => haystack.includes(kw))) {
      matches.push($(el));
    }
  });
  return matches;
}

function firstMatchText($sections) {
  for (const $sec of $sections) {
    const text = cleanText($sec.text());
    if (text.length > 20) return text;
  }
  return null;
}

function getInlineBgImage($el) {
  const style = $el.attr('style') || '';
  const match = style.match(/background-image:\s*url\(["']?([^"')]+)["']?\)/i);
  return match ? match[1] : null;
}

function extractEmail(text, $) {
  const mailto = $('a[href^="mailto:"]').first().attr('href');
  if (mailto) return mailto.replace(/^mailto:/i, '').split('?')[0].trim();
  const match = (text || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : null;
}

function extractPhone(text, $) {
  const tel = $('a[href^="tel:"]').first().attr('href');
  if (tel) return tel.replace(/^tel:/i, '').trim();
  const match = (text || '').match(
    /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/
  );
  return match ? match[0].trim() : null;
}

function extractLocation($, allText) {
  const locSections = findSections($, ['location', 'based', 'city', 'country']);
  for (const $sec of locSections) {
    const text = cleanText($sec.text());
    if (text.length > 3 && text.length < 120) return text;
  }
  const basedIn = allText.match(/(?:based in|located in|from)\s+([A-Z][a-zA-Z\s,]{2,40})/i);
  return basedIn ? cleanText(basedIn[1]) : null;
}

const NICHE_PATTERNS = [
  { niche: 'UGC Creator', patterns: [/ugc/i, /user[- ]generated/i, /content creator/i] },
  { niche: 'Photographer', patterns: [/photograph/i, /photo(?:graphy|grapher)/i] },
  { niche: 'Designer', patterns: [/design(?:er|ing)/i, /graphic/i, /brand(?:ing)?/i] },
  { niche: 'Videographer', patterns: [/video(?:graph)?/i, /filmmak/i, /reels?/i] },
  { niche: 'Influencer', patterns: [/influenc/i] },
  { niche: 'Model', patterns: [/model(?:ing)?/i] },
];

function detectNiche(text) {
  for (const { niche, patterns } of NICHE_PATTERNS) {
    if (patterns.some((p) => p.test(text))) return niche;
  }
  return null;
}

function cleanPersonName(raw) {
  if (!raw) return null;
  const cleaned = cleanText(
    raw
      .replace(/\s*[|\-–—]\s*.+$/, '')
      .replace(/\s*(portfolio|ugc|media|co|official|home|website)$/i, '')
  );
  return cleaned || null;
}

function extractPersonName($, ogTitle) {
  const h1 = cleanText($('h1').first().text());
  if (h1 && h1.length < 80) return cleanPersonName(h1);
  if (ogTitle) return cleanPersonName(ogTitle);
  const metaAuthor = $('meta[name="author"]').attr('content');
  if (metaAuthor) return cleanPersonName(metaAuthor);
  return null;
}

const SOCIAL_DOMAINS = {
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  linkedin: ['linkedin.com'],
  twitter: ['twitter.com', 'x.com'],
  facebook: ['facebook.com', 'fb.com'],
};

function classifySocialUrl(href) {
  if (!href) return null;
  const lower = href.toLowerCase();
  for (const [platform, domains] of Object.entries(SOCIAL_DOMAINS)) {
    if (domains.some((d) => lower.includes(d))) return platform;
  }
  return null;
}

function buildSocialLinks(socialLinks) {
  const social = {
    instagram: null,
    tiktok: null,
    youtube: null,
    linkedin: null,
    twitter: null,
    facebook: null,
    other: [],
  };

  for (const link of socialLinks) {
    const platform = classifySocialUrl(link.href);
    if (!platform) {
      social.other.push(link.href);
    } else if (!social[platform]) {
      social[platform] = link.href;
    }
  }

  return social;
}

function isExternal(href, baseHostname) {
  try {
    const host = new URL(href).hostname.replace(/^www\./, '');
    return host !== baseHostname.replace(/^www\./, '');
  } catch {
    return false;
  }
}

function categorizeLinks($, url) {
  const baseHostname = safe(() => new URL(url).hostname, '');
  const categories = { social: [], navigation: [], cta: [], external: [], internal: [] };
  const seen = new Set();

  $('a[href]').each((_, el) => {
    const $el = $(el);
    const href = toAbsolute($el.attr('href'), url);
    if (!href || seen.has(href)) return;
    seen.add(href);

    const text = cleanText($el.text());
    const entry = { text, href };
    const haystack = `${attrHaystack($el)} ${text.toLowerCase()}`;
    const platform = classifySocialUrl(href);

    if (platform) {
      categories.social.push(entry);
      return;
    }

    if ($el.closest('nav, header, [role="navigation"]').length > 0) {
      categories.navigation.push(entry);
    }

    const isCta =
      /cta|contact|hire|book|get started|work with|collab|inquir|quote|apply|lets go|let's go/i.test(
        haystack
      );
    if (
      isCta ||
      $el.is('button') ||
      ($el.attr('class') || '').includes('btn') ||
      $el.attr('role') === 'button'
    ) {
      categories.cta.push(entry);
    }

    if (isExternal(href, baseHostname)) {
      categories.external.push(entry);
    } else {
      categories.internal.push(entry);
    }
  });

  return categories;
}

function extractAllText($) {
  const $clone = cheerio.load($.html());
  $clone('script, style, noscript, svg, nav').remove();
  return cleanText($clone('body').text());
}

function extractLogoUrl($, url, ogImage) {
  const logoSelectors = [
    'img[alt*="logo" i]',
    'img[class*="logo" i]',
    'img[id*="logo" i]',
    'header img',
    '.logo img',
    '#logo img',
  ];

  for (const sel of logoSelectors) {
    const abs = toAbsolute($(sel).first().attr('src'), url);
    if (abs) return abs;
  }

  return ogImage || null;
}

function extractHero($, url) {
  const hero = {
    heading: null,
    subheading: null,
    ctaText: null,
    ctaUrl: null,
    backgroundImageUrl: null,
  };

  try {
    const $h1 = $('h1').first();
    hero.heading = cleanText($h1.text()) || null;

    const $heroSection =
      findSections($, ['hero', 'banner', 'intro', 'jumbotron'])[0] ||
      ($h1.length ? $h1.closest('section, header, div') : null);

    if ($heroSection && $heroSection.length) {
      const $sub = $heroSection.find('h2, h3, p').not($h1).first();
      if ($sub.length) {
        hero.subheading = cleanText($sub.text()) || null;
      }

      hero.backgroundImageUrl =
        toAbsolute(getInlineBgImage($heroSection), url) ||
        toAbsolute($heroSection.find('img').first().attr('src'), url);

      const $cta = $heroSection.find('a, button').filter((_, el) => {
        const t = cleanText($(el).text()).toLowerCase();
        return (
          t &&
          /contact|hire|book|work|start|collab|inquir|get|lets|let's|view|see|portfolio/i.test(t)
        );
      }).first();

      if ($cta.length) {
        hero.ctaText = cleanText($cta.text()) || null;
        hero.ctaUrl = toAbsolute($cta.attr('href'), url);
      }
    }

    if (!hero.subheading) {
      hero.subheading = cleanText($('h2').first().text()) || null;
    }
  } catch {
    // ignore
  }

  return hero;
}

function extractAbout($, url) {
  const about = { text: null, imageUrl: null };

  try {
    const $sections = findSections($, ['about', 'bio', 'story', 'me', 'who']);
    about.text = firstMatchText($sections);

    if (!about.text) {
      about.text =
        cleanText($('[class*="about" i], [id*="about" i]').first().text()) || null;
    }

    const searchIn = $sections.length ? $sections : [$('body')];
    for (const $sec of searchIn) {
      const $img = $sec.find('img').first();
      const abs = toAbsolute($img.attr('src'), url);
      if (abs && !/logo|icon|favicon/i.test(abs)) {
        about.imageUrl = abs;
        break;
      }
    }
  } catch {
    // ignore
  }

  return about;
}

function extractServices($) {
  const services = [];
  const seen = new Set();

  try {
    const $sections = findSections($, ['service', 'offer', 'package', 'price', 'pricing', 'plan']);

    for (const $sec of $sections) {
      const $items = $sec.find(
        '[class*="service" i], [class*="package" i], [class*="offer" i], [class*="card" i], li, article'
      );

      if ($items.length > 1) {
        $items.each((_, el) => {
          const $el = $(el);
          const title =
            cleanText($el.find('h2, h3, h4, strong, .title').first().text()) ||
            cleanText($el.text()).slice(0, 80);
          const description = cleanText($el.find('p').text()) || null;
          const priceMatch = $el.text().match(/(?:\$|€|£|USD|EUR)\s?\d[\d,.]*/);
          if (title && title.length > 2 && !seen.has(title)) {
            seen.add(title);
            services.push({
              title,
              description,
              price: priceMatch ? priceMatch[0] : null,
            });
          }
        });
      } else {
        const title = cleanText($sec.find('h2, h3').first().text());
        const description = cleanText($sec.text());
        if (title && !seen.has(title)) {
          seen.add(title);
          const priceMatch = description.match(/(?:\$|€|£|USD|EUR)\s?\d[\d,.]*/);
          services.push({
            title,
            description,
            price: priceMatch ? priceMatch[0] : null,
          });
        }
      }
    }
  } catch {
    // ignore
  }

  return services;
}

function mediaTypeFromUrl(mediaUrl) {
  if (!mediaUrl) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogg)(\?|$)/i.test(mediaUrl)) return 'video';
  return 'image';
}

function extractPortfolio($, url) {
  const portfolio = [];
  const seen = new Set();

  try {
    const $sections = findSections($, [
      'portfolio',
      'work',
      'gallery',
      'reel',
      'sample',
      'project',
      'showcase',
    ]);
    const $scope = $sections.length ? $sections : [$('body')];

    for (const $sec of $scope) {
      $sec
        .find('img[src], video[src], video source[src], a[href*=".mp4"], a[href*=".webm"]')
        .each((_, el) => {
          const $el = $(el);
          const mediaUrl = toAbsolute($el.attr('src') || $el.attr('href'), url);
          if (!mediaUrl || seen.has(mediaUrl)) return;
          seen.add(mediaUrl);

          const $card = $el.closest(
            '[class*="card" i], [class*="item" i], figure, article, li, div'
          );
          const title =
            cleanText($card.find('h2, h3, h4, figcaption, .title').first().text()) || null;
          const description = cleanText($card.find('p').first().text()) || null;
          const poster = $el.attr('poster');
          const thumbnailUrl =
            toAbsolute(poster, url) ||
            (mediaTypeFromUrl(mediaUrl) === 'image' ? mediaUrl : null);

          portfolio.push({
            title,
            description,
            mediaUrl,
            mediaType: mediaTypeFromUrl(mediaUrl),
            thumbnailUrl,
          });
        });
    }
  } catch {
    // ignore
  }

  return portfolio;
}

function extractTestimonials($) {
  const testimonials = [];
  const seen = new Set();

  try {
    const $sections = findSections($, ['testimonial', 'review', 'client', 'feedback', 'quote']);

    const process = ($el) => {
      const quote =
        cleanText($el.find('p, blockquote, q').first().text()) || cleanText($el.text());
      if (!quote || quote.length < 15 || seen.has(quote)) return;
      seen.add(quote);
      const author =
        cleanText(
          $el.find('[class*="author" i], [class*="name" i], cite, strong, h4, h5').first().text()
        ) || null;
      const company =
        cleanText($el.find('[class*="company" i], [class*="brand" i], em, span').first().text()) ||
        null;
      testimonials.push({ quote, author, company });
    };

    for (const $sec of $sections) {
      const $items = $sec.find(
        '[class*="testimonial" i], [class*="review" i], blockquote, [class*="card" i]'
      );
      if ($items.length) {
        $items.each((_, el) => process($(el)));
      } else {
        process($sec);
      }
    }
  } catch {
    // ignore
  }

  return testimonials;
}

function extractContact($, allText) {
  const contact = {
    email: null,
    phone: null,
    formPresent: false,
    ctaText: null,
  };

  try {
    const $sections = findSections($, ['contact', 'inquir', 'get-in-touch', 'reach']);
    const $scope = $sections[0] || $('body');

    contact.email = extractEmail($scope.text(), $scope);
    contact.phone = extractPhone($scope.text(), $scope);
    contact.formPresent = $scope.find('form, input[type="email"], textarea').length > 0;

    const $cta = $scope.find('a, button').filter((_, el) => {
      const t = cleanText($(el).text()).toLowerCase();
      return /contact|email|message|inquir|hire|book|reach|get in touch/i.test(t);
    }).first();

    contact.ctaText = $cta.length ? cleanText($cta.text()) : null;

    if (!contact.email) contact.email = extractEmail(allText, $);
    if (!contact.phone) contact.phone = extractPhone(allText, $);
  } catch {
    // ignore
  }

  return contact;
}

async function extractComputedBranding(page) {
  return page.evaluate(() => {
    const colorCounts = {};
    const fontCounts = {};

    const bump = (map, key) => {
      if (!key) return;
      map[key] = (map[key] || 0) + 1;
    };

    const toHex = (rgb) => {
      if (!rgb || rgb === 'transparent' || rgb === 'inherit') return null;
      if (rgb.startsWith('#')) return rgb.toLowerCase();
      const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return null;
      return (
        '#' +
        [m[1], m[2], m[3]]
          .map((n) => parseInt(n, 10).toString(16).padStart(2, '0'))
          .join('')
      );
    };

    const selectors =
      'body, h1, h2, h3, h4, h5, h6, p, a, button, section, header, footer, nav, li, span, div';

    document.querySelectorAll(selectors).forEach((el) => {
      const style = window.getComputedStyle(el);
      bump(colorCounts, toHex(style.backgroundColor));
      bump(colorCounts, toHex(style.color));
      const font = style.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
      bump(fontCounts, font);
    });

    const top = (map, n) =>
      Object.entries(map)
        .filter(([k]) => k && k !== '#000000' && k !== '#ffffff')
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k]) => k);

    return {
      colors: top(colorCounts, 8),
      fonts: top(fontCounts, 6),
    };
  });
}

function createEmptyMetadata(url) {
  return {
    url,
    scrapedAt: new Date().toISOString(),
    status: null,
    loadTimeMs: null,
    person: {
      name: null,
      bio: null,
      niche: null,
      location: null,
      email: null,
      phone: null,
    },
    branding: {
      pageTitle: null,
      colors: [],
      fonts: [],
      logoUrl: null,
    },
    socialLinks: {
      instagram: null,
      tiktok: null,
      youtube: null,
      linkedin: null,
      twitter: null,
      facebook: null,
      other: [],
    },
    sections: {
      hero: {
        heading: null,
        subheading: null,
        ctaText: null,
        ctaUrl: null,
        backgroundImageUrl: null,
      },
      about: { text: null, imageUrl: null },
      services: [],
      portfolio: [],
      testimonials: [],
      contact: {
        email: null,
        phone: null,
        formPresent: false,
        ctaText: null,
      },
    },
    allText: '',
    allLinks: {
      social: [],
      navigation: [],
      cta: [],
      external: [],
      internal: [],
    },
    screenshots: { desktop: null, mobile: null },
    assets: {
      images: [],
      videos: [],
      fonts: [],
      css: [],
      js: [],
    },
    error: null,
  };
}

function enrichMetadataFromHtml(metadata, html, url) {
  const $ = cheerio.load(html);

  const ogTitle = $('meta[property="og:title"]').attr('content') || null;
  const ogImage = $('meta[property="og:image"]').attr('content') || null;
  const metaDescription = $('meta[name="description"]').attr('content') || '';

  metadata.branding.pageTitle = cleanText($('title').text()) || ogTitle || null;
  metadata.allText = extractAllText($);
  metadata.allLinks = categorizeLinks($, url);
  metadata.socialLinks = buildSocialLinks(metadata.allLinks.social);
  metadata.branding.logoUrl = extractLogoUrl($, url, ogImage);

  metadata.sections.hero = extractHero($, url);
  metadata.sections.about = extractAbout($, url);
  metadata.sections.services = extractServices($);
  metadata.sections.portfolio = extractPortfolio($, url);
  metadata.sections.testimonials = extractTestimonials($);
  metadata.sections.contact = extractContact($, metadata.allText);

  metadata.person.name = extractPersonName($, ogTitle);
  metadata.person.bio = metadata.sections.about.text || metaDescription || null;
  metadata.person.niche = detectNiche(
    [metadata.branding.pageTitle, metadata.person.bio, metadata.allText.slice(0, 2000)].join(' ')
  );
  metadata.person.location = extractLocation($, metadata.allText);
  metadata.person.email =
    metadata.sections.contact.email || extractEmail(metadata.allText, $);
  metadata.person.phone =
    metadata.sections.contact.phone || extractPhone(metadata.allText, $);

  $('img[src]').each((_, el) => {
    const abs = toAbsolute($(el).attr('src'), url);
    if (abs) metadata.assets.images.push(abs);
  });
  $('video[src], video source[src]').each((_, el) => {
    const abs = toAbsolute($(el).attr('src'), url);
    if (abs) metadata.assets.videos.push(abs);
  });

  for (const key of Object.keys(metadata.assets)) {
    metadata.assets[key] = [...new Set(metadata.assets[key])];
  }
}

// ── Main scrape function ─────────────────────────────────────────────────────

async function scrapeUrl(url) {
  const folderName = urlToFolderName(url);
  const outputDir = path.resolve(RESULTS_DIR, folderName);
  const assetsDir = path.join(outputDir, 'assets');

  ensureDir(outputDir);
  ensureDir(assetsDir);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const metadata = createEmptyMetadata(url);
  const networkAssets = { css: [], js: [], images: [], videos: [], fonts: [] };

  try {
    // ── DESKTOP SCREENSHOT ──────────────────────────────
    const desktopCtx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    const desktopPage = await desktopCtx.newPage();

    desktopPage.on('request', (req) => {
      const u = req.url();
      const type = req.resourceType();
      if (type === 'stylesheet') networkAssets.css.push(u);
      if (type === 'script') networkAssets.js.push(u);
      if (type === 'image') networkAssets.images.push(u);
      if (type === 'media' || /\.(mp4|webm|mov)(\?|$)/i.test(u)) networkAssets.videos.push(u);
      if (type === 'font') networkAssets.fonts.push(u);
    });

    const startTime = Date.now();

    let response;
    try {
      response = await desktopPage.goto(url, {
        waitUntil: 'networkidle',
        timeout: TIMEOUT,
      });
    } catch {
      response = await desktopPage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT,
      });
    }

    metadata.loadTimeMs = Date.now() - startTime;
    metadata.status = response ? response.status() : null;

    await desktopPage.waitForTimeout(2000);

    const html = await desktopPage.content();
    fs.writeFileSync(path.join(outputDir, 'page.html'), html, 'utf8');

    try {
      const computed = await extractComputedBranding(desktopPage);
      metadata.branding.colors = computed.colors;
      metadata.branding.fonts = computed.fonts;
    } catch {
      // ignore
    }

    try {
      enrichMetadataFromHtml(metadata, html, url);
    } catch {
      // ignore
    }

    const desktopScreenshot = path.join(outputDir, 'desktop.png');
    await desktopPage.screenshot({ path: desktopScreenshot, fullPage: true });
    metadata.screenshots.desktop = 'desktop.png';

    await desktopCtx.close();

    // ── MOBILE SCREENSHOT ───────────────────────────────
    const mobileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      isMobile: true,
      hasTouch: true,
    });

    const mobilePage = await mobileCtx.newPage();

    try {
      await mobilePage.goto(url, {
        waitUntil: 'networkidle',
        timeout: TIMEOUT,
      });
    } catch {
      await mobilePage.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT,
      });
    }

    await mobilePage.waitForTimeout(2000);

    const mobileScreenshot = path.join(outputDir, 'mobile.png');
    await mobilePage.screenshot({ path: mobileScreenshot, fullPage: true });
    metadata.screenshots.mobile = 'mobile.png';

    await mobileCtx.close();

    metadata.assets.css = [...new Set([...metadata.assets.css, ...networkAssets.css])];
    metadata.assets.js = [...new Set([...metadata.assets.js, ...networkAssets.js])];
    metadata.assets.images = [...new Set([...metadata.assets.images, ...networkAssets.images])];
    metadata.assets.videos = [...new Set([...metadata.assets.videos, ...networkAssets.videos])];
    metadata.assets.fonts = [...new Set([...metadata.assets.fonts, ...networkAssets.fonts])];

    // ── DOWNLOAD MEDIA ASSETS ───────────────────────────
    const portfolioUrls = metadata.sections.portfolio.map((p) => p.mediaUrl).filter(Boolean);
    const toDownload = [...new Set([
      ...portfolioUrls,
      ...metadata.assets.images,
      ...metadata.assets.videos,
    ])].slice(0, 50);

    for (const assetUrl of toDownload) {
      try {
        const res = await axios.get(assetUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0',
          },
        });
        const ext = path.extname(new URL(assetUrl).pathname) || '.bin';
        const filename = urlToFolderName(assetUrl).slice(0, 60) + ext;
        fs.writeFileSync(path.join(assetsDir, filename), res.data);
      } catch {
        // skip failed asset downloads silently
      }
    }
  } catch (err) {
    metadata.error = err.message;
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    path.join(outputDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );

  return { folderName, outputDir, metadata };
}

module.exports = { scrapeUrl };
