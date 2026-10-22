'use strict';

// The host owns credentials, leases, retries, cursor commits and vault delivery.
const { createHash } = require('node:crypto');
const manifest = require('./papercusp.json');
const DESCRIPTOR = manifest.provider;
const API = 'https://graph.facebook.com/v23.0';
const fields = {
  profile: 'id,name,link,about,picture',
  post: 'id,message,story,created_time,updated_time,permalink_url,from,attachments',
  photo: 'id,name,created_time,updated_time,link,picture,images,from',
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' ? v.trim() : '';
const fault = (kind, message, extra) => Object.assign(new Error(`facebook_vault:${message}`), { kind, ...extra });
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const instant = (v) => str(v) && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

function normalize(entity, type) {
  if (!object(entity) || !str(entity.id)) throw fault('transient', `${type}_id_required`);
  const id = str(entity.id);
  const name = str(entity.name);
  const payload = { id, entityType: type, text: type === 'profile' ? str(entity.about) || name || id
    : type === 'post' ? str(entity.message) || str(entity.story) || '(Facebook post)' : name || '(Facebook photo)' };
  const author = type === 'profile' ? name || id : str(entity.from?.name) || str(entity.from?.id);
  if (author) payload.author = author;
  const url = type === 'post' ? str(entity.permalink_url) : str(entity.link);
  if (url) payload.url = url;
  const occurredAt = instant(entity.created_time) || instant(entity.updated_time);
  if (occurredAt) payload.occurredAt = occurredAt;
  if (instant(entity.updated_time)) payload.updatedAt = instant(entity.updated_time);
  if (type === 'profile' && object(entity.picture)) payload.picture = entity.picture;
  if (type === 'post' && Array.isArray(entity.attachments?.data) && entity.attachments.data.length) payload.media = entity.attachments.data;
  if (type === 'photo') payload.media = Array.isArray(entity.images) && entity.images.length ? entity.images
    : str(entity.picture) ? [{ url: str(entity.picture) }] : [];
  return { datatype: 'social-post', nativeId: id, event: `${type}.synced`, payload,
    ...(occurredAt ? { occurredAt } : {}), version: digest(payload) };
}

function fresh(seen = {}) {
  return { v: 1, phase: 'profile', after: null, pages: 0, seen, cycle: {} };
}
function decode(raw) {
  if (raw == null) return fresh();
  let state;
  try { state = JSON.parse(raw); } catch { throw fault('cursor-expired', 'cursor_unreadable'); }
  if (!object(state) || state.v !== 1 || !['profile', 'post', 'photo', 'ready'].includes(state.phase)
    || !(state.after === null || (typeof state.after === 'string' && state.after.length <= 8192))
    || !Number.isSafeInteger(state.pages) || state.pages < 0 || state.pages > 10000
    || !object(state.seen) || !object(state.cycle)
    || !Object.values(state.seen).every((v) => typeof v === 'string')
    || !Object.values(state.cycle).every((v) => typeof v === 'string')) throw fault('cursor-expired', 'cursor_invalid');
  return state.phase === 'ready' ? fresh(state.seen) : state;
}

async function graph(host, source, path, after) {
  const url = new URL(`${API}/${path}`);
  const type = path === 'me' ? 'profile' : path.endsWith('feed') ? 'post' : 'photo';
  url.searchParams.set('fields', fields[type]);
  if (type !== 'profile') url.searchParams.set('limit', '100');
  if (after) url.searchParams.set('after', after);
  const response = await host.fetch({ source, request: { url: url.href, method: 'GET' } });
  let body;
  try { body = JSON.parse(response.body); } catch { throw fault('transient', 'invalid_response'); }
  const code = body?.error?.code;
  const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (response.status === 429 || [4, 17, 32, 613, 80001].includes(code)) {
    const retry = Number(headers['retry-after']);
    throw fault('rate-limited', 'graph_throttled', Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {});
  }
  if ([401, 403].includes(response.status) || [10, 190, 200].includes(code)) throw fault('auth', 'graph_grant_refused');
  if (response.status < 200 || response.status >= 300 || !object(body) || body.error) throw fault('transient', 'graph_request_failed');
  return body;
}

// Use only the opaque Graph cursor; vendor paging URLs can contain access tokens.
function afterOf(body, previous) {
  if (!body.paging?.next) return null;
  const after = str(body.paging?.cursors?.after);
  if (!after || after.length > 8192 || after === previous) throw fault('cursor-expired', 'paging_made_no_progress');
  return after;
}

async function syncPage(request, host) {
  const state = decode(request.cursor);
  const type = state.phase;
  if (++state.pages > 10000) throw fault('transient', 'page_limit_exceeded');
  const body = await graph(host, request.source, type === 'profile' ? 'me' : type === 'post' ? 'me/feed' : 'me/photos', state.after);
  if (type !== 'profile' && !Array.isArray(body.data)) throw fault('transient', 'collection_data_required');
  const records = [];
  for (const entity of type === 'profile' ? [body] : body.data) {
    const record = normalize(entity, type);
    const key = `${type}:${record.nativeId}`;
    if (state.cycle[key] === record.version) continue;
    state.cycle[key] = record.version;
    if (state.seen[key] !== record.version) records.push(record);
  }
  state.after = type === 'profile' ? null : afterOf(body, state.after);
  if (!state.after) state.phase = type === 'profile' ? 'post' : type === 'post' ? 'photo' : 'ready';
  if (state.phase === 'ready') {
    // Keep only the current scan, so removed entities do not grow the cursor forever.
    state.seen = state.cycle;
    state.cycle = {};
  }
  return { records, nextCursor: JSON.stringify(state), hasMore: state.phase !== 'ready' };
}

async function invoke(request) {
  throw new Error(`provider_capability_unsupported:${request.capability}`);
}

module.exports = {
  name: manifest.name, version: manifest.version, papercusp: manifest.papercusp, capabilities: [],
  providerAdapter: { describe: () => DESCRIPTOR, syncPage, invoke },
};
