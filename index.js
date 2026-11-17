const fs = require('fs/promises');
const path = require('path');

const API = 'https://exsellentrp.com';
const DB_FILE = path.join(__dirname, 'db.json');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.error('Не задано TG_BOT_TOKEN або TG_CHAT_ID');
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Telegram ----------

async function sendTelegram(text, attempt = 1) {
    const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: TG_CHAT_ID,
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
        return sendTelegram(text, attempt + 1);
    }

    throw new Error(`Telegram ${res.status}: ${data.description ?? 'unknown error'}`);
}

async function notify(messages) {
    for (const msg of messages) {
        await sendTelegram(msg);
        await sleep(1100);
    }
}

// ---------- API ----------

async function getProperties() {
    const response = await fetch(`${API}/api/map/properties`, {
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
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

async function saveDb(properties) {
    const data = {
        updatedAt: new Date().toISOString(),
        properties,
    };
    await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
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

// ---------- Один прохід ----------

async function main() {
    const time = new Date().toISOString();
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
        await notify(messages); // якщо впаде, db.json не оновиться
    } else {
        console.log(`[${time}] Змін немає (${properties.length} об'єктів).`);
    }

    // Файл перезаписуємо лише коли дані справді змінилися,
    // щоб у репозиторій не летіли зайві коміти
    if (JSON.stringify(db.properties) !== JSON.stringify(properties)) {
        await saveDb(properties);
        console.log('db.json оновлено.');
    }
}

main().catch((err) => {
    console.error('Помилка перевірки:', err.message);
    process.exit(1);
});