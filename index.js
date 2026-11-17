const fs = require('fs/promises');
const path = require('path');

const API = 'https://exsellentrp.com';
const DB_FILE = path.join(__dirname, 'db.json');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;                 // основний канал (усі події)
const TG_CHAT_ID_FILTER = process.env.TG_CHAT_ID_FILTER;   // канал з фільтром (необов'язковий)

if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.error('Не задано TG_BOT_TOKEN або TG_CHAT_ID');
    process.exit(1);
}

// ---------- Налаштування фільтра ----------
const FILTER_MIN_HOUSE_PRICE = 1450000;

// Потрапляє в канал з фільтром: будь-який бізнес або будинок від мін. ціни
function matchesFilter(p) {
    if (p.kind === 'business') return true;
    if (p.kind === 'house') return Number(p.price) >= FILTER_MIN_HOUSE_PRICE;
    return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Telegram ----------

async function sendTelegram(chatId, text, attempt = 1) {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(30000),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) return;

    if (res.status === 429 && attempt <= 3) {
        const wait = (data.parameters?.retry_after ?? 5) + 1;
        await sleep(wait * 1000);
        return sendTelegram(chatId, text, attempt + 1);
    }

    throw new Error(`Telegram ${res.status}: ${data.description ?? 'unknown error'}`);
}

// Повертає true, якщо відправка в канал з фільтром не вдалася
async function notify(events) {
    let filterFailed = false;

    for (const ev of events) {
        // Основний канал: помилка тут зупиняє збереження db.json (повторимо наступного разу)
        await sendTelegram(TG_CHAT_ID, ev.text);
        await sleep(1100);

        // Канал з фільтром: помилка не блокує збереження бази, лише логується
        if (ev.filter && TG_CHAT_ID_FILTER) {
            try {
                await sendTelegram(TG_CHAT_ID_FILTER, ev.text);
            } catch (err) {
                filterFailed = true;
                console.error('Не вдалося відправити в канал з фільтром:', err.message);
            }
            await sleep(1100);
        }
    }

    return filterFailed;
}

// ---------- API ----------
// Один запит без повторів: при збої одразу кидаємо помилку,
// наступна спроба буде при наступному запуску

async function getProperties() {
    const response = await fetch(`${API}/api/map/properties`, {
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // Захист від порожньої або некоректної відповіді
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('некоректна відповідь API');
    }

    return data;
}

// ---------- Файл-БД ----------

async function loadDb() {
    try {
        const raw = await fs.readFile(DB_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function writeDb(data) {
    await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function saveDb(properties) {
    await writeDb({
        updatedAt: new Date().toISOString(),
        properties,
    });
}

// ---------- Допоміжні функції ----------

const keyOf = (p) => `${p.kind}:${p.id}`;

function formatPrice(price) {
    return `${Number(price).toLocaleString('de-DE')}$`;
}

function title(p) {
    if (p.name) {
        return `${p.name} (${p.id})`;
    }
    const kind = p.kind.charAt(0).toUpperCase() + p.kind.slice(1);
    return `${kind} (${p.id})`;
}

function getOtherProperties(list, owner, exceptKey) {
    if (!owner) return [];
    const ownerLower = owner.toLowerCase();

    return list.filter(
        (p) =>
            p.owned &&
            p.owner &&
            p.owner.toLowerCase() === ownerLower &&
            keyOf(p) !== exceptKey
    );
}

// ---------- Порівняння ----------
// Повертає масив подій: { text, filter }
// filter = true означає, що подію треба дублювати в канал з фільтром

function diffProperties(oldList, newList) {
    const oldMap = new Map(oldList.map((p) => [keyOf(p), p]));
    const events = [];

    for (const cur of newList) {
        const prev = oldMap.get(keyOf(cur));
        if (!prev) continue;

        if (prev.owned && !cur.owned) {
            const lines = [
                `📗 ${title(cur)} появился на продаже`,
                `📗 Гос. цена: ${formatPrice(cur.price)}`,
                `📗 Бывший владелец: ${prev.owner}`,
            ];

            const others = getOtherProperties(newList, prev.owner, keyOf(cur));
            if (others.length) {
                lines.push(`📗 Также во владении: ${others.map(title).join(', ')}`);
            }

            events.push({ text: lines.join('\n'), filter: matchesFilter(cur) });
        } else if (!prev.owned && cur.owned) {
            events.push({
                text:
                    `📕 ${title(cur)} был куплен\n` +
                    `📕 Гос. цена: ${formatPrice(cur.price)}\n` +
                    `📕 Новый владелец: ${cur.owner}`,
                filter: false,
            });
        } else if (prev.owned && cur.owned && prev.owner !== cur.owner) {
            events.push({
                text:
                    `📕 ${title(cur)} сменил владельца\n` +
                    `📕 Гос. цена: ${formatPrice(cur.price)}\n` +
                    `📕 Бывший владелец: ${prev.owner}\n` +
                    `📕 Новый владелец: ${cur.owner}`,
                filter: false,
            });
        }
    }

    return events;
}

// ---------- Обробка збою отримання даних ----------
// Сповіщення йде один раз на початку збою, далі мовчимо до відновлення.
// Стан зберігається в db.json (поле fetchFailing).

async function handleFetchFailure(db, err, time) {
    console.error(`[${time}] Не вдалося отримати актуальні дані: ${err.message}`);

    if (db?.fetchFailing) {
        console.log('Збій триває, повторне сповіщення не надсилаємо.');
        return;
    }

    try {
        await sendTelegram(
            TG_CHAT_ID,
            `⚠️ Не удалось получить актуальные данные (${err.message}).\n` +
            `⚠️ Проверка приостановлена, повторная попытка при следующем запуске.`
        );
    } catch (tgErr) {
        console.error('Не вдалося відправити сповіщення про збій:', tgErr.message);
        return; // прапорець не ставимо, спробуємо ще раз наступного разу
    }

    if (db) {
        await writeDb({ ...db, fetchFailing: true });
    }
}

// ---------- Один прохід ----------

async function main() {
    const time = new Date().toISOString();
    const db = await loadDb();

    let properties;
    try {
        properties = await getProperties();
    } catch (err) {
        await handleFetchFailure(db, err, time);
        return; // код завершення 0
    }

    // Зв'язок відновився після збою
    const wasFailing = Boolean(db?.fetchFailing);
    if (wasFailing) {
        try {
            await sendTelegram(TG_CHAT_ID, '✅ Связь с сервером восстановлена, проверка возобновлена.');
        } catch (err) {
            console.error('Не вдалося відправити сповіщення про відновлення:', err.message);
        }
    }

    if (!db) {
        await saveDb(properties);
        console.log(`[${time}] Перший запуск: збережено ${properties.length} об'єктів.`);
        return;
    }

    const events = diffProperties(db.properties, properties);

    if (events.length) {
        console.log(`[${time}] Змін: ${events.length}\n`);
        console.log(
            events.map((e) => (e.filter ? `[ФІЛЬТР]\n${e.text}` : e.text)).join('\n\n')
        );

        const filterFailed = await notify(events); // якщо основний канал впаде, db.json не оновиться
        if (filterFailed) process.exitCode = 1;
    } else {
        console.log(`[${time}] Змін немає (${properties.length} об'єктів).`);
    }

    // Зберігаємо, якщо дані змінилися або треба зняти прапорець збою
    if (wasFailing || JSON.stringify(db.properties) !== JSON.stringify(properties)) {
        await saveDb(properties);
        console.log('db.json оновлено.');
    }
}

main().catch((err) => {
    console.error('Помилка перевірки:', err.message);
    process.exit(1);
});
