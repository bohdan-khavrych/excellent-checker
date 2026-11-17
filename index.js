const fs = require('fs/promises');
const path = require('path');

const API = 'https://exsellentrp.com';
const DB_FILE = path.join(__dirname, 'db.json');
const INTERVAL_MS = 3 * 60 * 1000;

// ---------- Telegram ----------
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '9248665737:AAGX2TIZPIL-8igodhRnCSEAjSZbGDV6oYo';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '-1004457113832'; // або -100XXXXXXXXXX

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(text, attempt = 1) {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: TG_CHAT_ID,
            text,
            disable_web_page_preview: true,
        }),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.ok) return;

    // Telegram просить зачекати (ліміт повідомлень)
    if (res.status === 429 && attempt <= 3) {
        const wait = (data.parameters?.retry_after ?? 5) + 1;
        await sleep(wait * 1000);
        return sendTelegram(text, attempt + 1);
    }

    throw new Error(`Telegram ${res.status}: ${data.description ?? 'unknown error'}`);
}

async function notify(messages) {
    for (const msg of messages) {
        await sendTelegram(msg);
        await sleep(1100); // не перевищуємо ліміт Telegram для каналів
    }
}

// ---------- API ----------

async function getProperties() {
    const response = await fetch(`${API}/api/map/properties`);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
}

// ---------- Робота з файлом-БД ----------

async function loadDb() {
    try {
        const raw = await fs.readFile(DB_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
    }
}

async function saveDb(properties) {
    const tmp = `${DB_FILE}.tmp`;
    const data = {
        updatedAt: new Date().toISOString(),
        properties,
    };
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, DB_FILE);
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

// Уся активна нерухомість власника в поточному списку,
// крім об'єкта, який зараз виставлено на продаж
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

function diffProperties(oldList, newList) {
    const oldMap = new Map(oldList.map((p) => [keyOf(p), p]));
    const messages = [];

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

            messages.push(lines.join('\n'));
        } else if (!prev.owned && cur.owned) {
            messages.push(
                `📕 ${title(cur)} был куплен\n` +
                `📕 Гос. цена: ${formatPrice(cur.price)}\n` +
                `📕 Новый владелец: ${cur.owner}`
            );
        } else if (prev.owned && cur.owned && prev.owner !== cur.owner) {
            messages.push(
                `📕 ${title(cur)} сменил владельца\n` +
                `📕 Гос. цена: ${formatPrice(cur.price)}\n` +
                `📕 Бывший владелец: ${prev.owner}\n` +
                `📕 Новый владелец: ${cur.owner}`
            );
        }
    }

    return messages;
}

// ---------- Основний цикл ----------

async function check() {
    const time = new Date().toLocaleString('uk-UA');

    try {
        const properties = await getProperties();
        const db = await loadDb();

        if (!db) {
            await saveDb(properties);
            console.log(`[${time}] Перший запуск: збережено ${properties.length} об'єктів.`);
            return;
        }

        const messages = diffProperties(db.properties, properties);

        if (messages.length) {
            console.log(`[${time}] Змін: ${messages.length}\n`);
            console.log(messages.join('\n\n'));
            console.log();

            // Якщо відправка в Telegram впаде, db.json не оновиться,
            // і зміни буде повторно знайдено при наступній перевірці
            await notify(messages);
        } else {
            console.log(`[${time}] Змін немає (${properties.length} об'єктів).`);
        }

        await saveDb(properties);
    } catch (err) {
        console.error(`[${time}] Помилка перевірки:`, err.message);
    }
}

async function notifyStart() {
    const time = new Date().toLocaleString('uk-UA');
    try {
        await sendTelegram(`✅ Чекер успешно запущен.\n🕒 ${time}`);
        console.log(`[${time}] Повідомлення про запуск відправлено в Telegram.`);
    } catch (err) {
        // помилка Telegram не повинна зупиняти запуск чекера
        console.error(`[${time}] Не вдалося відправити повідомлення про запуск:`, err.message);
    }
}

async function main() {
    await notifyStart();
    await check();
    setInterval(check, INTERVAL_MS);
}

main();