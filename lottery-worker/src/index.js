const DEFAULT_ROSTER = ['Ryan', 'Eric', 'Mandi', 'Kyle', 'Lindsey', 'Jen', 'Kaci', 'Tyler'];
const ANIMATION_MS = 4000;
const PAUSE_AFTER_LANDING_MS = 10000;
const REVEAL_INTERVAL_MS = ANIMATION_MS + PAUSE_AFTER_LANDING_MS;
const STATE_KEY = 'lottery-state';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function withCors(response, origin, allowedOrigin) {
  const headers = new Headers(response.headers);
  if (!origin || origin === allowedOrigin || origin === 'http://localhost:8787') {
    headers.set('access-control-allow-origin', origin || allowedOrigin);
    headers.set('vary', 'Origin');
    headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
    headers.set('access-control-allow-headers', 'content-type, x-lottery-admin');
    headers.set('access-control-max-age', '86400');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function normalizedRoster(input) {
  if (!Array.isArray(input)) return null;
  const roster = [];
  const seen = new Set();
  for (const value of input) {
    const name = String(value || '').trim().replace(/\s+/g, ' ');
    const key = name.toLocaleLowerCase();
    if (name && name.length <= 40 && !seen.has(key)) {
      seen.add(key);
      roster.push(name);
    }
  }
  return roster.length >= 2 && roster.length <= 16 ? roster : null;
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const swapIndex = random[0] % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function defaultState() {
  return {
    version: 1,
    roster: DEFAULT_ROSTER,
    scheduleAt: null,
    order: [],
    createdAt: null,
    updatedAt: Date.now()
  };
}

function phaseFor(state, now) {
  if (!state.scheduleAt) return { phase: 'waiting', revealedCount: 0, active: null };
  if (now < state.scheduleAt) return { phase: 'countdown', revealedCount: 0, active: null };
  const elapsed = now - state.scheduleAt;
  const drawIndex = Math.floor(elapsed / REVEAL_INTERVAL_MS);
  if (drawIndex >= state.order.length) {
    return { phase: 'complete', revealedCount: state.order.length, active: null };
  }
  const inCurrentDraw = elapsed % REVEAL_INTERVAL_MS;
  if (inCurrentDraw < ANIMATION_MS) {
    return {
      phase: 'drawing',
      revealedCount: drawIndex,
      active: { pick: drawIndex + 1, manager: state.order[drawIndex], startedAt: state.scheduleAt + drawIndex * REVEAL_INTERVAL_MS, landsAt: state.scheduleAt + drawIndex * REVEAL_INTERVAL_MS + ANIMATION_MS }
    };
  }
  return { phase: 'drawing', revealedCount: drawIndex + 1, active: null };
}

function publicState(state, now = Date.now()) {
  const timing = phaseFor(state, now);
  return {
    version: state.version,
    roster: state.roster,
    scheduleAt: state.scheduleAt,
    order: state.order.slice(0, timing.revealedCount),
    phase: timing.phase,
    active: timing.active,
    timing: { animationMs: ANIMATION_MS, pauseAfterLandingMs: PAUSE_AFTER_LANDING_MS, revealIntervalMs: REVEAL_INTERVAL_MS },
    updatedAt: state.updatedAt,
    serverNow: now
  };
}

export class LotteryState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async readState() {
    return (await this.ctx.storage.get(STATE_KEY)) || defaultState();
  }

  async writeState(state) {
    state.updatedAt = Date.now();
    await this.ctx.storage.put(STATE_KEY, state);
    return state;
  }

  authorized(request) {
    const expected = this.env.LOTTERY_ADMIN_PASSPHRASE;
    return Boolean(expected) && request.headers.get('x-lottery-admin') === expected;
  }

  async requestBody(request) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (method === 'GET' && path === '/v1/lottery/state') {
      return json(publicState(await this.readState()));
    }

    if (method !== 'POST' || !['/v1/lottery/lock', '/v1/lottery/reset', '/v1/lottery/roster'].includes(path)) {
      return json({ error: 'Not found.' }, 404);
    }
    if (!this.env.LOTTERY_ADMIN_PASSPHRASE) return json({ error: 'Lottery protection is not configured yet.' }, 503);
    if (!this.authorized(request)) return json({ error: 'Enter the lottery admin passphrase to make that change.' }, 401);
    const state = await this.readState();
    const body = await this.requestBody(request);

    if (path === '/v1/lottery/reset') {
      state.scheduleAt = null;
      state.order = [];
      state.createdAt = null;
      return json(publicState(await this.writeState(state)));
    }

    if (path === '/v1/lottery/roster') {
      if (state.scheduleAt) return json({ error: 'Reset the locked drawing before replacing its manager list.' }, 409);
      const roster = normalizedRoster(body.roster);
      if (!roster) return json({ error: 'Send between 2 and 16 unique manager names.' }, 400);
      state.roster = roster;
      state.order = [];
      return json(publicState(await this.writeState(state)));
    }

    const roster = normalizedRoster(body.roster || state.roster);
    const scheduleAt = Number(body.scheduleAt);
    if (!roster) return json({ error: 'Send between 2 and 16 unique manager names.' }, 400);
    if (!Number.isFinite(scheduleAt) || scheduleAt < Date.now() + 1000) {
      return json({ error: 'Choose a future lottery date and time.' }, 400);
    }
    state.roster = roster;
    state.scheduleAt = Math.floor(scheduleAt);
    state.order = shuffle(roster);
    state.createdAt = Date.now();
    return json(publicState(await this.writeState(state)));
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowedOrigin = env.ALLOWED_ORIGIN || 'https://rye14001.github.io';
    if (origin && origin !== allowedOrigin && origin !== 'http://localhost:8787') {
      return withCors(json({ error: 'This lottery service only accepts the Family Feudball site.' }, 403), origin, allowedOrigin);
    }
    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204 }), origin, allowedOrigin);
    }
    const id = env.LOTTERY_STATE.idFromName('family-feudball-primary-lottery');
    return withCors(await env.LOTTERY_STATE.get(id).fetch(request), origin, allowedOrigin);
  }
};
