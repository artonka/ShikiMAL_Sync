// ==UserScript==
// @name         Shiki → MAL Sync (v1.4.2)
// @namespace    shiki-mal-sync
// @version      1.4.2
// @description  Односторонняя синхронизация списка Shikimori → MyAnimeList (аниме, манга, ранобэ): статус, прогресс, оценка, заметки. ID берётся из URL, авторизация через code + PKCE.
// @author       artonka
// @license      MIT
// @match        *://shiki.one/*
// @match        *://shikimori.one/*
// @match        *://shikimori.me/*
// @match        *://shikimori.io/*
// @match        https://myanimelist.net/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @connect      myanimelist.net
// @connect      api.myanimelist.net
// ==/UserScript==

(function () {
'use strict';

const REDIRECT_URI = 'https://myanimelist.net/';
const POLL_MS = 15000;
const API = 'https://api.myanimelist.net/v2';
const OAUTH = 'https://myanimelist.net/v1/oauth2';
const SYNC_NOTES = true; // переносить заметку (text на Шикимори → comments на MAL)

/* Типы контента (ключ — первый сегмент URL на Шикимори).
 * path: раздел на Шикимори (он же ключ); status: статус Шикимори → статус MAL; flag / count / again: «пересматриваю» (флаг и счётчик на MAL, подпись у значка ↻);
 * prog: поля прогресса { shiki — поле на Шикимори, write — параметр записи на MAL, read — поле чтения с MAL, label — подпись }.
 * Ранобэ: на MAL это раздел manga, а запись списка на Шикимори лежит под target_type=Manga. */
const ANIME = {
    name: 'anime', path: 'animes', api: 'anime', rateType: 'Anime', active: 'watching',
    status: { planned: 'plan_to_watch', watching: 'watching', rewatching: 'watching', completed: 'completed', on_hold: 'on_hold', dropped: 'dropped' },
    flag: 'is_rewatching', count: 'num_times_rewatched', again: 'Пересматриваю',
    prog: [{ shiki: 'episodes', write: 'num_watched_episodes', read: 'num_episodes_watched', label: 'ep.' }]
};
const MANGA = {
    api: 'manga', rateType: 'Manga', active: 'reading',
    status: { planned: 'plan_to_read', watching: 'reading', rewatching: 'reading', completed: 'completed', on_hold: 'on_hold', dropped: 'dropped' },
    flag: 'is_rereading', count: 'num_times_reread', again: 'Перечитываю',
    prog: [
        { shiki: 'chapters', write: 'num_chapters_read', read: 'num_chapters_read', label: 'ch.' },
        { shiki: 'volumes', write: 'num_volumes_read', read: 'num_volumes_read', label: 'vol.' }
    ]
};
const KINDS = { animes: ANIME, mangas: { name: 'manga', path: 'mangas', ...MANGA }, ranobe: { name: 'ranobe', path: 'ranobe', ...MANGA } };

/* ---------- утилиты ---------- */

const $ = id => document.getElementById(id);
const el = (tag, props) => Object.assign(document.createElement(tag), props);
const form = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined)).toString();
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const authErr = () => Object.assign(new Error('Нужна авторизация'), { auth: true });

function rand(n) {
    const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return Array.from(a, b => cs[b % cs.length]).join('');
}

/* Пауза из заголовка Retry-After (секунды, не больше 10 минут); если заголовка нет, минута. */
const retryMs = h => { const m = /retry-after:\s*(\d+)/i.exec(h || ''); return m ? Math.min(+m[1], 600) * 1000 : 60000; };

function gmReq(opts) {
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            ...opts,
            timeout: 15000,
            onload: r => {
                let json = null;
                try { json = JSON.parse(r.responseText); } catch { /* не JSON */ }
                resolve({ status: r.status, json, wait: r.status === 429 ? retryMs(r.responseHeaders) : 0 });
            },
            onerror: () => reject(new Error('Сеть недоступна')),
            ontimeout: () => reject(new Error('Таймаут запроса'))
        });
    });
}

/* Заметки Шикимори могут содержать BBCode, а MAL хранит простой текст: убираем известные теги. */
const BBCODE = /\[\/?(?:b|i|u|s|url|spoiler|spoiler_block|quote|center|right|size|color|img|code|list|poster)(?:=[^\]]*)?\]/gi;
const cleanNote = t => (t || '').replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, '$2 ($1)').replace(BBCODE, '').trim();
/* MAL отдаёт комментарии в виде HTML (<br /> вместо переносов, &hellip; и т. п.): приводим к простому тексту для сравнения. */
const plainNote = x => {
    const ta = document.createElement('textarea');
    ta.innerHTML = String(x || '').replace(/<br\s*\/?>/gi, '');
    return ta.value.replace(/\s+/g, '');
};

/* ---------- OAuth: authorization code + PKCE (plain) ---------- */

async function tokenRequest(params) {
    const r = await gmReq({
        method: 'POST',
        url: OAUTH + '/token',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        data: form({ client_id: GM_getValue('client_id', ''), ...params })
    });
    if (r.status !== 200 || !r.json || !r.json.access_token) {
        throw Object.assign(new Error(`Токен не получен (${r.status})`), { status: r.status });
    }
    const t = { access: r.json.access_token, refresh: r.json.refresh_token, exp: Date.now() + (r.json.expires_in - 60) * 1000 };
    GM_setValue('tokens', t);
    return t;
}

function startAuth() {
    let id = GM_getValue('client_id', '');
    if (!id) {
        id = (prompt('Вставьте Client ID вашего приложения MAL:') || '').trim();
        if (!id) return;
        GM_setValue('client_id', id);
    }
    const verifier = rand(96), state = rand(16);
    GM_setValue('pkce', { verifier, state });
    const q = form({ response_type: 'code', client_id: id, code_challenge: verifier, code_challenge_method: 'plain', state, redirect_uri: REDIRECT_URI });
    window.open(`${OAUTH}/authorize?${q}`, 'mal_auth', 'width=520,height=700');
}

async function getToken() {
    let t = GM_getValue('tokens', null);
    if (!t) throw authErr();
    if (Date.now() > t.exp) {
        try {
            t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh });
        } catch (e) {
            if (e.status === 400 || e.status === 401) { GM_deleteValue('tokens'); throw authErr(); }
            throw e;
        }
    }
    return t.access;
}

/* Запрос к API MAL. При 401 один раз обновляем токен и повторяем запрос; повторный 401 — нужна авторизация. */
async function mal(method, path, params, retry = true) {
    const r = await gmReq({
        method,
        url: API + path,
        headers: { Authorization: 'Bearer ' + await getToken(), ...(params && { 'Content-Type': 'application/x-www-form-urlencoded' }) },
        data: params ? form(params) : undefined
    });
    if (r.status === 401) {
        if (!retry) throw authErr();
        const t = GM_getValue('tokens', null);
        if (t) GM_setValue('tokens', { ...t, exp: 0 }); // принудительный refresh
        return mal(method, path, params, false);
    }
    if (r.status === 429) throw Object.assign(new Error('MAL просит подождать (429)'), { wait: r.wait });
    return r;
}

/* ---------- Shikimori: чтение списка через API сайта ---------- */

/* Текущая страница: { k — описание типа, id, key }. Ключ вида anime_1535, manga_5, ranobe_162032
 * используется для всех данных тайтла в хранилище: snap_<key>, sent_<key>, map_<key>. */
function here() {
    const m = location.pathname.match(/^\/(animes|mangas|ranobe)\/[a-z]*(\d+)/);
    if (!m) return null;
    const k = KINDS[m[1]], id = +m[2];
    return { k, id, key: `${k.name}_${id}` };
}

/* ID тайтла на MAL: привязка вручную (map_<key>) или ID со страницы Шикимори. */
const malId = pg => GM_getValue('map_' + pg.key, 0) || pg.id;
const malUrl = (k, mid) => `https://myanimelist.net/${k.api}/${mid}`;

async function shikiGet(path) {
    const r = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (r.status === 429) throw Object.assign(new Error('Shikimori просит подождать (429)'), { status: 429, wait: Math.min(+r.headers.get('Retry-After') || 60, 600) * 1000 });
    if (!r.ok) throw Object.assign(new Error('Shikimori ответил ' + r.status), { status: r.status });
    return r.json();
}

/* ID пользователя: сначала из DOM (body[data-user]), запрос /api/users/whoami только если в DOM пусто. */
let whoamiId = null;
async function userId() {
    try { const id = JSON.parse(document.body.dataset.user || '{}').id; if (id) return id; } catch { /* в DOM нет данных */ }
    if (!whoamiId) {
        const me = await shikiGet('/api/users/whoami');
        if (!me || !me.id) throw new Error('Войдите в аккаунт Шикимори');
        whoamiId = me.id;
    }
    return whoamiId;
}

async function getRate(k, id) {
    const list = await shikiGet(`/api/v2/user_rates?user_id=${await userId()}&target_id=${id}&target_type=${k.rateType}`);
    return list[0] || null;
}

const pick = r => ({ status: r.status, score: r.score, episodes: r.episodes, chapters: r.chapters, volumes: r.volumes, rewatches: r.rewatches, text: r.text || '' });
const sameRate = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/* Отправляем только изменившиеся поля; даты ставим только если их ещё нет на MAL. */
function toMal(k, n, prev, ml, auto) {
    const ch = f => !prev || prev[f] !== n[f];
    const p = {};
    if (ch('status')) { p.status = k.status[n.status]; p[k.flag] = n.status === 'rewatching'; }
    for (const { shiki, write } of k.prog) if (ch(shiki)) p[write] = n[shiki];
    if (ch('score') && (prev || n.score > 0 || (ml && ml.score > 0))) p.score = n.score;
    if (ch('rewatches') && (prev || n.rewatches > 0)) p[k.count] = n.rewatches;
    if (SYNC_NOTES) {
        const note = cleanNote(n.text);
        if (!prev) { if (note && !(ml && ml.comments)) p.comments = note; } // первая отправка: чужой комментарий на MAL не трогаем
        else if (prev.text !== n.text) p.comments = note;                    // заметку изменили или очистили на Шикимори
    }
    if (auto && p.status === k.active && !(ml && ml.start_date)) p.start_date = localDate();
    if (auto && p.status === 'completed' && !(ml && ml.finish_date)) p.finish_date = localDate();
    return p;
}

/* Отличается ли запись на MAL (m) от записи на Шикимори (n). */
function differs(k, n, m) {
    const note = SYNC_NOTES && cleanNote(n.text);
    return m.status !== k.status[n.status]
        || k.prog.some(x => m[x.read] !== n[x.shiki])
        || (m.score || 0) !== n.score
        || (!!note && plainNote(m.comments) !== plainNote(note));
}

/* Что делать с тайтлом. Чистая функция: без сети и хранилища.
 * mode: load / poll / force; now — запись на Шикимори или null; snap — снимок прошлой синхронизации или null;
 * same — now совпадает со snap; onMal — есть ли запись на MAL. */
function decide(mode, now, snap, same, onMal) {
    if (mode === 'force') return now ? 'push_all' : snap ? 'delete' : 'no_record';
    if (!now) return !snap ? 'no_record' : mode === 'poll' ? 'delete' : 'ask_delete';
    if (!snap) return onMal ? 'baseline' : 'create';
    return same ? 'synced' : 'update';
}

/* ---------- панель (встроена в страницу под обложкой, оформление по теме Edesign) ---------- */

const WARN_ICON = '<svg viewBox="0 0 16 16"><path d="M8 3.5v5.5M8 11.5v.5"/></svg>';
const ICONS = {
    ok: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-6.5"/></svg>',
    warn: WARN_ICON,
    info: WARN_ICON,
    error: '<svg viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
    process: '<i class="msync-spin"></i>',
    again: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/></svg>'
};

/* Если на странице есть переменные темы Edesign (--block-color и др.), цвета берутся из них (значения после запятой запасные).
 * Если темы нет, на панель и подсказку ставится класс msync-clean (см. syncThemeClass): вид как у штатных
 * элементов чистой темы Шикимори.
 * Цвет главной кнопки зависит от результата: атрибут data-st (см. ui) задаёт переменные состояния
 * --s-fg (текст), --s-bg (фон), --s-hv (фон при наведении), --s-ic (значок), в чистой теме ещё --s-bd и --s-hb (рамка);
 * без состояния (process) действуют запасные значения из var().
 * Тот же CSS подключается на странице MAL (ensureCss): кнопка возврата и карточка авторизации берут тему из хранилища (applyTheme). */
const CSS = `
#msync,.msync-pop{--m-btn:var(--block-color,40,39,80);--m-btn-text:var(--bright-color,174,164,255);--m-hover:var(--hover-buttoms-2,156,98,25);--m-popup:var(--popup-color,34,34,65);--m-popup-text:var(--light-color,200,196,234);--m-muted:var(--dull-color,137,132,167);--m-border:var(--shadows-color,94,91,136)}
#msync{margin-top:8px;font-family:Comfortaa,sans-serif}
#msync .msync-row{display:flex;gap:4px}
#msync .msync-btn{box-sizing:border-box;height:24px;padding:2px 0 !important;border:0 !important;border-radius:10px !important;cursor:pointer;text-decoration:none !important;font:400 12px/1 Comfortaa,sans-serif !important;text-align:center;display:flex;align-items:center;justify-content:center;transition:.3s;color:var(--s-fg,rgba(var(--m-btn-text),1)) !important;background:var(--s-bg,rgba(var(--m-btn),.6)) !important}
#msync .msync-btn:hover{background:var(--s-hv,rgba(var(--m-hover),.7)) !important;color:#fff !important;box-shadow:0 2px 6px 2px rgba(0,0,0,.2) !important}
#msync .msync-main{flex:1;min-width:0;gap:5px;padding:2px 5px !important}
#msync .msync-label{flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#msync.msync-off .msync-label{opacity:.5}
#msync .msync-sq{width:28px;flex:none}
#msync svg,.msync-card svg{fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round}
#msync .msync-sq svg{width:14px;height:14px;stroke-width:1.8}
#msync .msync-icon{flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center;color:var(--s-ic);filter:drop-shadow(0 0 1px rgba(0,0,0,.25))}
#msync .msync-icon svg{width:16px;height:16px;stroke-width:2.2}
#msync #msync_go[data-st="ok"]{--s-fg:rgba(var(--white-color,234,229,255),1);--s-bg:rgba(var(--anime-complete,41,107,47),.75);--s-hv:rgba(var(--anime-inprocess,69,146,76),.9);--s-ic:rgb(168,240,176)}
#msync #msync_go[data-st="warn"]{--s-fg:rgba(var(--white-color,234,229,255),1);--s-bg:rgba(var(--hover-buttoms-2,156,98,25),.75);--s-hv:rgba(var(--hover-color,210,137,45),.9);--s-ic:rgb(255,218,140)}
#msync #msync_go[data-st="error"]{--s-fg:rgba(var(--white-color,234,229,255),1);--s-bg:rgba(var(--manga-complete,153,0,62),.75);--s-hv:rgba(var(--manga-inprocess,189,15,86),.9);--s-ic:rgb(255,165,195)}
#msync #msync_go[data-st="info"]{--s-ic:rgba(var(--m-muted),1)}
#msync .msync-spin{width:12px;height:12px;box-sizing:border-box;border-radius:50%;border:2px solid rgba(var(--m-muted),.4);border-top-color:rgba(var(--m-btn-text),1);animation:msync-spin .8s linear infinite}
@keyframes msync-spin{to{transform:rotate(360deg)}}
#msync .msync-info{margin-top:5px;min-height:14px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:center;color:rgba(var(--m-muted),1)}
#msync .msync-again{display:inline-block;width:11px;height:11px;vertical-align:-1px;cursor:default}
#msync .msync-again svg{width:11px;height:11px;stroke-width:1.9}
.msync-pop{position:fixed;display:none;z-index:2147483000;box-sizing:border-box;background:rgba(var(--m-popup),1);color:rgba(var(--m-popup-text),1);border:1px solid rgba(var(--m-border),.5);border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.45);font-size:12px;line-height:1.5}
#msync_tip{padding:8px 12px;max-width:300px;white-space:pre-line}
/* ---- чистая тема Шикимори (без Edesign): кнопки как .b-link_button, подсказка белая ---- */
#msync.msync-clean{--m-muted:123,128,132}
#msync.msync-clean .msync-btn{border:1px solid var(--s-bd,rgb(62,77,93)) !important;border-radius:0 !important;background:var(--s-bg,rgb(68,85,102)) !important;color:var(--s-fg,#fff) !important;box-shadow:none !important;font-family:"Open Sans","Helvetica Neue",Arial,Verdana,sans-serif !important}
#msync.msync-clean .msync-btn:hover{background:var(--s-hv,rgb(29,120,183)) !important;border-color:var(--s-hb,rgb(28,114,174)) !important;color:#fff !important;box-shadow:none !important}
#msync.msync-clean .msync-spin{border-color:rgba(255,255,255,.35);border-top-color:#fff}
#msync.msync-clean #msync_go[data-st="ok"]{--s-bg:rgb(65,149,65);--s-bd:rgb(58,134,58);--s-hv:rgb(52,121,52);--s-hb:rgb(47,109,47);--s-ic:#fff}
#msync.msync-clean #msync_go[data-st="warn"]{--s-bg:rgb(230,150,30);--s-bd:rgb(207,135,27);--s-hv:rgb(196,128,26);--s-hb:rgb(176,115,23);--s-ic:#fff}
#msync.msync-clean #msync_go[data-st="error"]{--s-bg:rgb(252,87,94);--s-bd:rgb(227,78,85);--s-hv:rgb(219,66,73);--s-hb:rgb(197,59,66);--s-ic:#fff}
.msync-pop.msync-clean{background:#fff;color:rgb(51,51,51);border:1px solid rgb(204,204,204);border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.2);font-family:"Helvetica Neue",Arial,Verdana,sans-serif;font-size:13px;line-height:1.6}
/* ---- страница MAL: плавающая кнопка «← На Шикимори» (внутри #msync) и карточка результата авторизации.
   Фон кнопки Edesign на MAL непрозрачный: полупрозрачный фон Шикимори на светлой странице MAL выглядел бы блёклым ---- */
#msync.msync-float{position:fixed;right:20px;bottom:20px;z-index:9999;margin:0}
#msync.msync-float .msync-btn{height:28px;padding:0 12px !important;white-space:nowrap}
#msync.msync-float:not(.msync-clean){--s-bg:rgb(var(--m-btn));--s-hv:rgb(var(--m-hover))}
.msync-backdrop{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:#121212}
.msync-backdrop.msync-clean{background:rgb(240,240,240)}
.msync-pop.msync-card{position:static;display:flex;align-items:center;gap:14px;max-width:min(360px,calc(100vw - 40px));padding:18px 22px;font-size:14px;line-height:1.5;overflow-wrap:anywhere}
.msync-pop.msync-card:not(.msync-clean){font-family:Comfortaa,sans-serif}
.msync-card-icon{flex:none;display:flex;color:var(--s-ic)}
.msync-card-icon svg{width:28px;height:28px;stroke-width:1.5}
.msync-card.is-ok{--s-ic:rgb(168,240,176)}
.msync-card.is-error{--s-ic:rgb(255,165,195)}
.msync-card.msync-clean.is-ok{--s-ic:rgb(65,149,65)}
.msync-card.msync-clean.is-error{--s-ic:rgb(252,87,94)}
`;

/* Создаёт элемент с данным id, если его ещё нет в документе. */
function ensure(id, tag, parent, props) {
    if (!$(id)) parent.appendChild(el(tag, { id, ...props }));
}

const ensureCss = () => ensure('msync_css', 'style', document.head, { textContent: CSS });

/* Переменные темы Edesign, которые нужны странице MAL (см. applyTheme). */
const THEME_VARS = ['--block-color', '--bright-color', '--hover-buttoms-2', '--popup-color', '--light-color', '--shadows-color'];
let themeSig = '';

/* Есть ли на странице тема Edesign: проверяем одну из её переменных. Без темы включается «чистый» вид.
 * Состояние темы запоминаем в хранилище (theme_clean, theme_vars) для страницы MAL; пишем только при изменении. */
function syncThemeClass() {
    const cs = getComputedStyle(document.documentElement);
    const themed = !!cs.getPropertyValue('--block-color').trim();
    for (const id of ['msync', 'msync_tip']) $(id)?.classList.toggle('msync-clean', !themed);
    const vars = {};
    if (themed) for (const v of THEME_VARS) { const val = cs.getPropertyValue(v).trim(); if (val) vars[v] = val; }
    const sig = JSON.stringify(vars);
    if (sig === themeSig) return;
    themeSig = sig;
    GM_setValue('theme_clean', !themed);
    if (themed) GM_setValue('theme_vars', vars); else GM_deleteValue('theme_vars');
}

/* «5 минут назад», «2 часа назад»; старше суток дата дд-мм-гг. */
const plural = (n, a, b, c) => { const m = n % 100, d = n % 10; return (m > 10 && m < 20) ? c : d === 1 ? a : (d >= 2 && d <= 4) ? b : c; };
function ago(ts) {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return 'только что';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
    const d = new Date(ts), p2 = n => String(n).padStart(2, '0');
    return `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${String(d.getFullYear()).slice(2)}`;
}

/* Текст подсказки: сообщение о статусе + время последней отправки на MAL. */
function tipText() {
    const ic = $('msync_icon'), pg = here();
    if (!ic) return '';
    const t = ic.dataset.tip || '';
    const sent = pg ? GM_getValue('sent_' + pg.key, 0) : 0;
    return sent ? (t ? t + '\n' : '') + 'Последняя отправка на MAL: ' + ago(sent) : t;
}

/* Если надпись не помещается в кнопку, уменьшаем шрифт (не меньше 9px, шаг 0.5px) вместо обрезки многоточием.
 * Ширина текста пропорциональна размеру шрифта, поэтому размер считается одним расчётом, без цикла. */
function fitLabel() {
    const l = document.querySelector('#msync .msync-label');
    if (!l) return;
    l.style.fontSize = '';
    const cw = l.clientWidth, sw = l.scrollWidth, base = parseFloat(getComputedStyle(l).fontSize) || 12;
    if (cw > 0 && sw > cw) l.style.fontSize = Math.max(9, Math.floor(base * cw / sw * 2) / 2) + 'px';
}

function hideTip() {
    const t = $('msync_tip');
    if (t) t.style.display = 'none';
}

/* Подсказка живёт в body (а не в панели), чтобы её не обрезал контейнер обложки.
 * Появляется у правого верхнего угла элемента (может выходить за ширину обложки). */
function showTip(anchor, text) {
    const el = $('msync_tip');
    if (!el || !text) return;
    el.textContent = text;
    el.style.display = 'block';
    const a = anchor.getBoundingClientRect(), w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(8, Math.min(a.right + 4, window.innerWidth - w - 8)) + 'px';
    el.style.top = Math.max(8, a.top - h - 4) + 'px';
}

/* Подсказка при наведении на элемент; text — функция, возвращающая текст. */
function bindTip(el, text) {
    el.onmouseenter = () => showTip(el, text());
    el.onmouseleave = hideTip;
}

function updateLink() {
    const pg = here(), a = $('msync_link');
    if (!pg || !a) return;
    a.href = malUrl(pg.k, malId(pg));
}

function setOff(flag) {
    $('msync')?.classList.toggle('msync-off', flag);
}

/* Обратный индекс MAL → Шикимори (rmap) для кнопки «← На Шикимори» на странице MAL.
 * Ключ `${api}_${ID на MAL}`, значение { path — раздел на Шикимори, id }. Хранится только то, чего не видно по URL MAL:
 * ручная привязка и ранобэ (на MAL это раздел manga). prev — прежний ID привязки (при смене или сбросе в changeId). */
function updateBackIndex(pg, prev = 0) {
    const { k, id } = pg, mid = malId(pg);
    const rmap = GM_getValue('rmap', {}), before = JSON.stringify(rmap);
    const old = `${k.api}_${prev || id}`;
    const now = mid !== id || k.path === 'ranobe' ? `${k.api}_${mid}` : null;
    const mine = e => !!e && e.path === k.path && e.id === id;
    if (old !== now && mine(rmap[old])) delete rmap[old];
    if (now) rmap[now] = { path: k.path, id };
    if (JSON.stringify(rmap) !== before) GM_setValue('rmap', rmap);
}

function changeId() {
    const pg = here();
    if (!pg) return;
    const prev = GM_getValue('map_' + pg.key, 0);
    const v = prompt(`ID тайтла на MyAnimeList (по умолчанию ${pg.id}).\nПустое значение сбрасывает привязку:`, prev || '');
    if (v === null) return;
    if (/^\d+$/.test(v.trim())) GM_setValue('map_' + pg.key, +v.trim()); else GM_deleteValue('map_' + pg.key);
    GM_deleteValue('snap_' + pg.key);
    updateBackIndex(pg, prev);
    updateLink();
    check('load');
}

/* Результат отображается значком на главной кнопке (ok ✓, warn/info «!», error ✗, process — индикатор),
 * цветом кнопки (data-st) и текстом в подсказке при наведении на значок. */
function ui(type, text) {
    const ic = $('msync_icon');
    if (!ic) return;
    ic.innerHTML = ICONS[type] || '';
    ic.dataset.tip = text || '';
    $('msync_go').dataset.st = type;
    const tip = $('msync_tip');
    if (tip && tip.style.display === 'block' && text) tip.textContent = tipText();
}

/* Строка под кнопками: «MAL: completed • 28 ep. • 7★»; при повторном просмотре/чтении после статуса значок ↻ с подсказкой.
 * Размер шрифта (11px) подобран так, чтобы самая длинная строка помещалась в одну строчку. */
function showMal(k, mid, ml) {
    const link = $('msync_link'), info = $('msync_info');
    if (link) link.href = malUrl(k, mid);
    if (!info) return;
    info.textContent = '';
    if (!ml) { info.append('MAL: нет в списке'); return; }
    info.append(`MAL: ${ml.status}`);
    if (ml[k.flag]) {
        const a = document.createElement('span');
        a.className = 'msync-again';
        a.innerHTML = ICONS.again;
        bindTip(a, () => k.again);
        info.append(' ', a);
    }
    info.append(` • ${k.prog.map(x => `${ml[x.read]} ${x.label}`).join(', ')} • ${ml.score || '-'}★`);
}

/* Панель вставляется сразу после блока статуса/оценки (div.b-user_rate) под обложкой.
 * Возвращает null (на странице панели быть не должно), 'ok' (панель на месте) или 'new' (только что создана). */
function ensurePanel() {
    const anchor = here() && document.querySelector('.c-image .b-user_rate');
    let panel = $('msync');
    if (!anchor) { panel?.remove(); hideTip(); return null; }
    ensureCss();
    ensure('msync_tip', 'div', document.body, { className: 'msync-pop' });
    if (panel) {
        if (panel.previousElementSibling !== anchor) anchor.after(panel);
        syncThemeClass();
        return 'ok';
    }
    panel = el('div', { id: 'msync' });
    panel.innerHTML = `
        <div class="msync-row">
            <button type="button" id="msync_go" class="msync-btn msync-main" title="Перенести этот тайтл на MAL"><span class="msync-label">Синхронизировать</span><span id="msync_icon" class="msync-icon"></span></button>
            <a id="msync_link" class="msync-btn msync-sq" target="_blank" rel="noopener" title="Открыть на MyAnimeList"><svg viewBox="0 0 16 16"><path d="M5 11L11 5M6 5h5v5"/></svg></a>
            <button type="button" id="msync_id" class="msync-btn msync-sq" title="Привязать тайтл к MAL ID вручную">ID</button>
        </div>
        <div id="msync_info" class="msync-info"></div>`;
    anchor.after(panel);
    syncThemeClass();
    $('msync_go').onclick = () => { if (GM_getValue('tokens', null)) check('force'); else startAuth(); }; // нет доступа: клик сразу запускает вход
    $('msync_id').onclick = changeId;
    bindTip($('msync_icon'), tipText);
    ui('process', 'Загрузка…');
    updateLink();
    fitLabel();
    document.fonts?.ready.then(fitLabel);
    return 'new';
}

/* ---------- страница MAL: завершение авторизации и ссылка назад ---------- */

/* На MAL своих переменных Edesign нет: тему берём из хранилища, куда её кладёт syncThemeClass на Шикимори. */
function applyTheme(...els) {
    const clean = GM_getValue('theme_clean', false), vars = GM_getValue('theme_vars', null) || {};
    for (const e of els) {
        e.classList.toggle('msync-clean', clean);
        if (!clean) for (const [name, value] of Object.entries(vars)) e.style.setProperty(name, value);
    }
}

/* Результат авторизации: карточка по центру окна (ok — токен сохранён, иначе текст ошибки). */
function authCard(ok, text) {
    ensureCss();
    const card = el('div', { className: `msync-pop msync-card ${ok ? 'is-ok' : 'is-error'}` });
    card.append(el('span', { className: 'msync-card-icon', innerHTML: ICONS[ok ? 'ok' : 'error'] }), el('div', { textContent: text }));
    const wrap = el('div', { className: 'msync-backdrop' });
    wrap.append(card);
    applyTheme(wrap, card);
    document.body.replaceChildren(wrap);
}

async function finishAuth(q, saved) {
    try {
        if (!q.get('code')) throw new Error(q.get('error') || 'MAL не вернул код');
        await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), code_verifier: saved.verifier, redirect_uri: REDIRECT_URI });
        GM_deleteValue('pkce');
        authCard(true, 'Готово! Токен сохранён. Окно закроется автоматически…');
        setTimeout(() => window.close(), 1500);
    } catch (e) {
        authCard(false, 'Ошибка авторизации: ' + e.message);
    }
}

/* Кнопка «← На Шикимори» на странице тайтла MAL. Сначала ищем тайтл в обратном индексе rmap (ручная привязка, ранобэ),
 * иначе обычный переход: anime → /animes/ID, manga → /mangas/ID. */
function backLink() {
    const m = location.pathname.match(/^\/(anime|manga)\/(\d+)/);
    if (!m) return;
    const e = (GM_getValue('rmap', null) || {})[`${m[1]}_${m[2]}`];
    const to = e && KINDS[e.path]?.path === e.path && e.id ? `${e.path}/${e.id}` : `${m[1] === 'anime' ? 'animes' : 'mangas'}/${m[2]}`;
    ensureCss();
    const box = el('div', { id: 'msync', className: 'msync-float' });
    box.append(el('a', { className: 'msync-btn', href: `${GM_getValue('last_shiki_domain', 'https://shikimori.one')}/${to}`, textContent: '← На Шикимори' }));
    applyTheme(box);
    document.body.appendChild(box);
}

/* ---------- основная логика ---------- */

let busy = false, again = null, retryAfter = 0;

/* Отправка изменений на MAL. c — контекст проверки (см. check). */
async function send(c, params) {
    const { k, mid, key, now, ml, say } = c;
    if (!Object.keys(params).length) { GM_setValue('snap_' + key, now); say('ok', 'Без изменений'); return; }
    const path = `/${k.api}/${mid}/my_list_status`;
    let w = await mal('PUT', path, params);
    let sent = true, noteFailed = false;
    if (w.status === 400 && 'comments' in params) {
        // возможно, MAL не принял заметку: повторяем без неё
        const rest = { ...params };
        delete rest.comments;
        sent = Object.keys(rest).length > 0;
        w = sent ? await mal('PUT', path, rest) : { status: 200, json: ml };
        noteFailed = true;
    }
    if (w.status !== 200) throw new Error(`MAL отклонил запрос (${w.status})`);
    GM_setValue('snap_' + key, now);
    if (sent) GM_setValue('sent_' + key, Date.now());
    c.show(w.json);

    // проверка: перечитываем заметку с MAL (ответ на PUT может не отражать то, что реально сохранено)
    let bent = false;
    if (!noteFailed && params.comments) {
        const r = await mal('GET', `/${k.api}/${mid}?fields=my_list_status{comments}`);
        const got = r.status === 200 && r.json && r.json.my_list_status;
        if (got) {
            bent = plainNote(got.comments) !== plainNote(params.comments);
            if (bent) console.log('[MAL Sync] заметка: отправлено', JSON.stringify(params.comments), '| сохранено на MAL', JSON.stringify(got.comments || ''));
        }
    }
    // MAL мог принять запрос, но оставить прежнюю оценку: сверяем с ответом на PUT
    const score = w.json && w.json.score;
    const scoreBad = sent && 'score' in params && typeof score === 'number' && score !== params.score;
    if (scoreBad) console.log('[MAL Sync] оценка: отправлено', params.score, '| ответ MAL', score);

    if (noteFailed) say('warn', 'Заметку MAL не принял (длина?)');
    else if (scoreBad) say('warn', `MAL не изменил оценку (у него ${score || '-'})`);
    else if (bent) say('warn', 'MAL сохранил заметку иначе — проверьте');
    else say('ok', 'Отправлено на MAL');
}

async function removeOnMal(c) {
    const d = await mal('DELETE', `/${c.k.api}/${c.mid}/my_list_status`);
    if (d.status !== 200 && d.status !== 404) throw new Error(`Не удалось удалить (${d.status})`);
    GM_deleteValue('snap_' + c.key);
    GM_setValue('sent_' + c.key, Date.now());
    c.show(null);
    c.say('ok', 'Удалено на MAL');
}

/* mode: 'load' — открыта страница, 'poll' — фоновая проверка, 'force' — кнопка.
 * Снимок snap_<key> хранится только для тайтлов, которые есть в списке на Шикимори. */
async function check(mode) {
    const pg = here();
    if (!pg) return;
    if (busy) { if (!again || mode !== 'poll') again = mode; return; }
    busy = true;
    const { k, id, key } = pg;
    const live = () => here()?.key === key; // пользователь не ушёл на другой тайтл
    const say = (type, text) => { if (live()) ui(type, text); };
    try {
        const fetchNow = async () => { const r = await getRate(k, id); return r ? pick(r) : null; };
        let now = await fetchNow(); // null: тайтла нет в списке на Шикимори
        const snap = GM_getValue('snap_' + key, null);
        if (live()) setOff(!now && !snap);
        if (mode === 'poll') {
            if (sameRate(snap, now) || (!now && !snap)) return;
            if (!now) {
                // запись пропала с момента прошлой синхронизации: удаляем на MAL только после контрольного запроса через 3 с
                await new Promise(res => setTimeout(res, 3000));
                now = await fetchNow();
            }
        }

        say('process', 'Проверка…');
        const mid = malId(pg);
        const fields = ['status', k.flag, 'score', ...k.prog.map(x => x.read), 'start_date', 'finish_date', 'comments'].join(',');
        const r = await mal('GET', `/${k.api}/${mid}?fields=my_list_status{${fields}}`);
        if (r.status === 404) throw new Error(`На MAL нет тайтла ${k.api}/${mid}`);
        if (r.status !== 200) throw new Error(`MAL ответил ${r.status}`);
        const ml = r.json.my_list_status || null;
        const show = ml => { if (live()) showMal(k, mid, ml); };
        show(ml);

        const c = { k, mid, key, now, ml, say, show };
        switch (decide(mode, now, snap, sameRate(snap, now), !!ml)) {
            case 'push_all': await send(c, toMal(k, now, null, ml, false)); break;
            case 'delete': await removeOnMal(c); break;
            case 'no_record': say('info', 'На Шикимори нет записи'); break;
            case 'ask_delete': say('warn', 'Запись удалена на Шикимори — нажмите «Синхронизировать» для удаления на MAL'); break;
            case 'baseline': // первое знакомство с тайтлом: ничего не затираем на MAL
                GM_setValue('snap_' + key, now);
                if (differs(k, now, ml)) say('warn', 'MAL отличается — нажмите «Синхронизировать»'); else say('ok', 'Списки совпадают');
                break;
            case 'create': await send(c, toMal(k, now, null, ml, true)); break;
            case 'synced': say('ok', 'Синхронизировано'); break;
            case 'update': await send(c, toMal(k, now, snap, ml, true)); break;
        }
    } catch (e) {
        if (e.auth) { GM_deleteValue('tokens'); say('error', 'Нужна авторизация: нажмите «Синхронизировать»'); }
        else { say('error', e.message); retryAfter = Date.now() + (e.wait || 60000); }
    } finally {
        busy = false;
        if (again) { const m = again; again = null; setTimeout(() => check(m), 0); }
    }
}

/* ---------- запуск ---------- */

if (location.hostname === 'myanimelist.net') {
    const q = new URLSearchParams(location.search);
    const saved = GM_getValue('pkce', null);
    if (saved && q.get('state') === saved.state && (q.get('code') || q.get('error'))) finishAuth(q, saved);
    else backLink();
} else {
    GM_setValue('last_shiki_domain', location.origin);
    GM_registerMenuCommand('MAL Sync: сбросить вход (Client ID и токен)', () => {
        GM_deleteValue('client_id');
        GM_deleteValue('tokens');
        alert('Готово. Нажмите «Синхронизировать» на странице тайтла: скрипт запросит Client ID и откроет вход в MAL.');
    });
    if (typeof GM_addValueChangeListener === 'function') {
        GM_addValueChangeListener('tokens', (name, oldV, newV) => { if (newV) check('load'); });
    }
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', fitLabel);

    let lastPath = null, lastPoll = 0, debounce = 0;
    setInterval(() => {
        const state = ensurePanel();
        const moved = location.pathname !== lastPath;
        lastPath = location.pathname;
        if (!state) return;
        if (moved || state === 'new') { lastPoll = Date.now(); updateBackIndex(here()); check('load'); }
        else if (!document.hidden && Date.now() - lastPoll >= POLL_MS && Date.now() > retryAfter) { lastPoll = Date.now(); check('poll'); }
    }, 1000);

    // вернулись на вкладку: один внеплановый опрос
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && here() && Date.now() > retryAfter) { lastPoll = Date.now(); check('poll'); }
    });

    // Любое изменение списка страница отправляет XHR-запросом на /api/v2/user_rates[/{id}[/increment]].
    // Ловим завершённый запрос (без query-параметров, поэтому собственные чтения скрипта с ?user_id=… не считаются)
    // и проверяем список почти сразу. Форма /user_rates/{id}/edit под фильтр не подходит.
    const MUTATION = /^https?:\/\/[^/?#]+\/api\/v2\/user_rates(?:\/\d+(?:\/increment)?)?$/;
    try {
        new PerformanceObserver(list => {
            if (!here() || Date.now() < retryAfter || !list.getEntries().some(e => MUTATION.test(e.name))) return;
            clearTimeout(debounce);
            debounce = setTimeout(() => check('poll'), 400);
        }).observe({ type: 'resource' });
    } catch { /* наблюдатель недоступен: остаётся плановый опрос */ }
}
})();