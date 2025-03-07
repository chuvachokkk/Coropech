require('dotenv').config(); // Подключаем dotenv для .env

const express = require('express');
const puppeteer = require('puppeteer');
const WebSocket = require('ws');
const cron = require('node-cron');
const { Sequelize, DataTypes } = require('sequelize');
const fs = require('fs').promises;

const app = express();

// Настройка Sequelize с условным SSL
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: process.env.NODE_ENV === 'production' ? { require: true, rejectUnauthorized: false } : false
  }
});

const PriceHistory = sequelize.define('PriceHistory', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  url: { type: DataTypes.TEXT, allowNull: false },
  name: { type: DataTypes.TEXT, allowNull: false },
  product_name: { type: DataTypes.TEXT, allowNull: false },
  price: { type: DataTypes.INTEGER, allowNull: false },
  timestamp: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
}, { tableName: 'price_history', timestamps: false });

const ProductLink = sequelize.define('ProductLink', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  url: { type: DataTypes.TEXT, allowNull: false, unique: true },
  competitor_id: { type: DataTypes.INTEGER, allowNull: true },
  created_at: { type: DataTypes.DATE, defaultValue: Sequelize.NOW },
}, { tableName: 'product_links', timestamps: false });

const MAX_CONCURRENT_PAGES = 20;

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.93 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.82 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/91.0.864.59',
];

let productLinks = new Map();
let currentPrices = {};

(async () => {
  try {
    await sequelize.sync({ alter: true });
    console.log('База данных инициализирована');

    const links = await ProductLink.findAll({ attributes: ['url', 'competitor_id'] });
    productLinks = new Map(links.map(link => [link.url, { competitor_id: link.competitor_id }]));
    productLinks.forEach((_, url) => (currentPrices[url] = { name: null, productName: null, price: null }));
    console.log('Загружены ссылки из БД:', productLinks.size);

    if (productLinks.size > 0) {
      console.log('Запуск начального парсинга...');
      await updatePrices();
    }
  } catch (err) {
    console.error('Ошибка при запуске сервера:', err);
    process.exit(1);
  }
})();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getDataFromPage(page, url) {
  try {
    if (!url) throw new Error('URL не определён');
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(randomUserAgent);

    await page.setViewport({
      width: 1280 + Math.floor(Math.random() * 200),
      height: 720 + Math.floor(Math.random() * 200),
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'platform', { get: () => ['Win32', 'MacIntel', 'Linux x86_64'][Math.floor(Math.random() * 3)] });
    });

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    try {
      const cookies = await fs.readFile('cookies.json', 'utf8');
      await page.setCookie(...JSON.parse(cookies));
    } catch (e) {
      console.log('Cookies не найдены, начинаем с чистого листа');
    }

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(4000 + Math.floor(Math.random() * 6000));

    const scrollCount = Math.floor(Math.random() * 5) + 3;
    for (let i = 0; i < scrollCount; i++) {
      await page.evaluate(() => {
        const scrollStep = Math.floor(Math.random() * 600) + 400;
        window.scrollBy(0, scrollStep * (Math.random() > 0.5 ? 1 : -1));
      });
      await sleep(2000 + Math.floor(Math.random() * 3000));
    }

    await page.mouse.move(
      Math.floor(Math.random() * 800) + 200,
      Math.floor(Math.random() * 600) + 100
    );
    await sleep(1500 + Math.floor(Math.random() * 2500));
    await page.evaluate(() => {
      const safeElements = document.querySelectorAll('p, div, span, a');
      if (safeElements.length > 0) {
        const randomElement = safeElements[Math.floor(Math.random() * safeElements.length)];
        randomElement.click();
      }
    });
    await sleep(2000 + Math.floor(Math.random() * 3000));

    const hasCaptcha = await page.$('input[type="text"]') || await page.$('div[id*="captcha"]');
    if (hasCaptcha) {
      console.warn(`[WARNING] Обнаружена капча на ${url}`);
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ action: 'captchaDetected', url }));
        }
      });
      return null;
    }

    const storeName = await page.waitForFunction(() => {
      const el = document.querySelector('.userNick.auto-shy a');
      return el ? el.textContent.trim() : null;
    }, { timeout: 60000 }).then(el => el.jsonValue()).catch(() => null);

    const productName = await page.waitForFunction(() => {
      const el = document.querySelector('.inplace.viewbull-field__model-name[data-field="model"]');
      return el ? el.textContent.trim() : null;
    }, { timeout: 60000 }).then(el => el.jsonValue()).catch(() => null);

    const priceAttr = await page.waitForFunction(() => {
      const el = document.querySelector('.viewbull-summary-price__value') || document.querySelector('[data-field="price"]');
      return el ? el.getAttribute('data-bulletin-price') : null;
    }, { timeout: 60000 }).then(el => el.jsonValue()).catch(() => null);

    if (!storeName || !productName || !priceAttr) {
      console.warn(`[WARNING] Не все данные найдены на ${url} после 60 секунд`);
      return null;
    }

    const price = parseInt(priceAttr);
    const newCookies = await page.cookies();
    await fs.writeFile('cookies.json', JSON.stringify(newCookies, null, 2));

    return { name: storeName, productName, price, url };
  } catch (error) {
    console.error(`Ошибка получения данных с ${url}: ${error.message}`);
    return null;
  }
}

async function updatePrices() {
  if (productLinks.size === 0) {
    console.log('Нет ссылок для проверки цен');
    return;
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const urls = Array.from(productLinks.keys());
  const pages = [];

  for (let i = 0; i < Math.min(MAX_CONCURRENT_PAGES, urls.length); i++) {
    pages.push(await browser.newPage());
  }

  async function processQueue() {
    for (let i = 0; i < urls.length; i += MAX_CONCURRENT_PAGES) {
      const chunk = urls.slice(i, i + MAX_CONCURRENT_PAGES);
      const chunkPromises = chunk.map((url, idx) =>
        getDataFromPage(pages[idx % pages.length], url).then(result => ({ url, result }))
      );
      const chunkResults = await Promise.all(chunkPromises);

      chunkResults.forEach(({ url, result }) => {
        if (result) {
          const { name, productName, price } = result;
          const prevData = currentPrices[url];
          const competitorId = productLinks.get(url).competitor_id;
          if (!prevData || prevData.price !== price) {
            console.log(`${name}: Цена изменилась — Товар: ${productName}, Цена: ${prevData?.price || 'N/A'} -> ${price}, Конкурент: ${competitorId}`);
            currentPrices[url] = { name, productName, price };
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                  action: 'priceChange',
                  url,
                  name,
                  productName,
                  oldPrice: prevData?.price || null,
                  newPrice: price,
                  competitorId
                }));
              }
            });
            PriceHistory.create({ url, name, product_name: productName, price })
              .catch(err => console.error('Ошибка сохранения в БД:', err));
          }
        }
      });

      await sleep(20000 + Math.floor(Math.random() * 20000));
    }
  }

  await processQueue();
  await Promise.all(pages.map(page => page.close()));
  await browser.close();

  if (Math.random() < 0.33) {
    await fs.unlink('cookies.json').catch(() => {});
    console.log('Cookies очищены');
  }
}

const server = app.listen(process.env.PORT || 3000, () => {
  console.log(`Сервер запущен на порту ${process.env.PORT || 3000}`);
});

const wss = new WebSocket.Server({ server });

wss.on('connection', async ws => {
  console.log('Клиент подключился');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Получено сообщение от клиента:', data);

      if (data.action === 'updateLinks' && Array.isArray(data.links)) {
        const normalizedLinks = data.links.map(link => 
          typeof link === 'string' ? { url: link, competitor_id: 0 } : { url: link.url, competitor_id: link.competitorId || 0 }
        );
        const newLinks = new Map(normalizedLinks.map(link => [link.url, { competitor_id: link.competitor_id }]));

        const linksToAdd = [...newLinks].filter(([url]) => !productLinks.has(url));
        const linksToRemove = [...productLinks].filter(([url]) => !newLinks.has(url));

        productLinks = newLinks;
        currentPrices = {};
        productLinks.forEach((_, url) => (currentPrices[url] = { name: null, productName: null, price: null }));

        for (const [url, { competitor_id }] of linksToAdd) {
          if (url) await ProductLink.upsert({ url, competitor_id });
        }
        for (const [url] of linksToRemove) {
          if (url) await ProductLink.destroy({ where: { url } });
        }

        await updatePrices();
      } else if (data.action === 'add' && data.url) {
        if (data.url.startsWith('https://www.farpost.ru/') && !productLinks.has(data.url)) {
          const competitorId = data.competitorId || 0;
          console.log(`Добавлена новая ссылка: ${data.url}, Конкурент: ${competitorId}`);
          productLinks.set(data.url, { competitor_id: competitorId });
          currentPrices[data.url] = { name: null, productName: null, price: null };
          await ProductLink.upsert({ url: data.url, competitor_id: competitorId });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ action: 'add', url: data.url, competitorId }));
            }
          });
          await updatePrices();
        } else {
          ws.send(JSON.stringify({ error: 'Ссылка уже существует или неверна' }));
        }
      } else if (data.action === 'remove' && data.url) {
        if (productLinks.delete(data.url)) {
          delete currentPrices[data.url];
          await ProductLink.destroy({ where: { url: data.url } });
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({ action: 'remove', url: data.url }));
            }
          });
        }
      }
    } catch (error) {
      console.error('Ошибка обработки сообщения клиента:', error.message);
    }
  });
});

cron.schedule('0 */6 * * *', async () => {
  console.log('Проверка цен для нечувствительных товаров...');
  await updatePrices();
}, {
  timezone: "Asia/Vladivostok"
});