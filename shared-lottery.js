/* Shared Family Feudball lottery state. The Worker is the source of truth so
   the scheduled drawing looks identical on every phone and desktop. */
(() => {
  'use strict';

  const API_BASE = 'https://family-feudball-lottery.rye14001.workers.dev/v1/lottery';
  const sleeperLeagueId = '1389710030378405888';
  const sleeperAliases = { ryanlemieux: 'Ryan', ericyensan: 'Eric', mandiyensan: 'Mandi', kyleyensan: 'Kyle', lindseyhouck: 'Lindsey', jgadomski: 'Jen', kaciyen: 'Kaci', yennykid: 'Tyler' };
  const originalSetLotteryActive = window.setLotteryActive;
  const legacySchedule = lotterySchedule;
  let state = null;
  let pollTimer = null;
  let syncing = false;
  let rosterKey = '';
  let resultsKey = '';
  let activeKey = '';

  function setError(message) {
    const element = document.getElementById('lottery-schedule-error');
    if (element) element.textContent = message || '';
  }

  function requestPassphrase() {
    const value = window.prompt('Enter the lottery admin passphrase. It is needed only to lock, reset, or refresh this shared drawing.');
    if (!value) return null;
    return value;
  }

  async function api(path, options = {}) {
    const response = await fetch(API_BASE + path, { cache: 'no-store', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || 'The shared lottery service could not complete that request.');
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function showStatus() {
    if (!state) return;
    const status = document.getElementById('lottery-status');
    const note = document.getElementById('lottery-draw-note');
    if (state.phase === 'complete') {
      status.textContent = 'Draft order complete';
      note.textContent = `All ${state.roster.length} picks are official. Direct complaints to the laws of probability.`;
      lotteryCountdown.classList.remove('long');
      lotteryCountdown.textContent = '✓';
    } else if (state.phase === 'waiting') {
      status.textContent = 'Waiting for a locked date';
      note.textContent = 'Choose a local date and time. The gumball machine starts itself at zero.';
      lotteryCountdown.classList.add('long');
      lotteryCountdown.textContent = '--:--:--';
    } else if (state.phase === 'countdown') {
      status.textContent = 'Lottery starts in';
      note.textContent = 'The date is locked for every screen. The gumball machine starts itself at zero.';
      lotteryCountdown.classList.add('long');
      lotteryCountdown.textContent = countdownText(state.scheduleAt - Date.now());
    } else if (state.active) {
      status.textContent = `Pick #${state.active.pick} is dispensing`;
      note.textContent = `${state.active.manager} was called. Watch the gumball drop into official slot #${state.active.pick}.`;
      lotteryCountdown.classList.remove('long');
      lotteryCountdown.textContent = '0';
    } else {
      const elapsed = Math.max(0, Date.now() - state.scheduleAt);
      const untilNext = state.timing.revealIntervalMs - (elapsed % state.timing.revealIntervalMs);
      status.textContent = 'Next gumball arrives in';
      note.textContent = `${state.roster.length - state.order.length} managers are still bouncing. The next gumball drops automatically after its ten-second pause.`;
      lotteryCountdown.classList.remove('long');
      lotteryCountdown.textContent = Math.max(0, Math.ceil(untilNext / 1000));
    }
  }

  function playActiveBall(active) {
    const key = `${active.pick}|${active.manager}|${active.startedAt}`;
    if (activeKey === key || !lotteryPanelActive) return;
    activeKey = key;
    lotteryPickNum = active.pick;
    const ball = lotteryBalls.find(item => item.name === active.manager);
    const slot = createPendingLotterySlot(active.manager);
    lotteryDrawing = true;
    animateBallToSlot(ball, active.manager, slot).finally(() => { lotteryDrawing = false; });
  }

  function applyState(next) {
    state = next;
    window.parent.postMessage({ type: 'feudboard-lottery-state', active: Boolean(next.scheduleAt && next.phase !== 'complete') }, '*');
    const nextRosterKey = next.roster.join('|');
    const nextResultsKey = next.order.join('|');
    const rosterChanged = nextRosterKey !== rosterKey;
    const resultsChanged = nextResultsKey !== resultsKey;
    rosterKey = nextRosterKey;
    resultsKey = nextResultsKey;
    lotteryRoster = [...next.roster];
    lotteryResults = [...next.order];
    lotteryNames = lotteryRoster.filter(name => !lotteryResults.includes(name));
    lotteryPickNum = lotteryResults.length + 1;
    lotterySchedule = next.scheduleAt || null;
    lotteryDateEditing = false;
    lotteryPhase = next.phase === 'complete' ? 'complete' : (next.phase === 'drawing' ? 'running' : 'waiting');
    if (rosterChanged || resultsChanged) {
      ballChamber.innerHTML = '';
      lotteryBalls = [];
      renderSavedLotteryResults();
      if (lotteryPanelActive && lotteryNames.length) buildLotteryBalls();
      refreshLotteryScheduleUI();
    }
    if (next.active) playActiveBall(next.active);
    showStatus();
  }

  async function sync() {
    if (syncing) return;
    syncing = true;
    try {
      applyState(await api('/state'));
    } catch (_) {
      if (lotteryPanelActive) {
        document.getElementById('lottery-status').textContent = 'Shared lottery unavailable';
        document.getElementById('lottery-draw-note').textContent = 'Check the live connection, then the shared date and order will reappear.';
      }
    } finally {
      syncing = false;
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    sync();
    pollTimer = setInterval(sync, lotteryPanelActive ? 1000 : 30000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function admin(path, body) {
    const options = value => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-lottery-admin': value }, body: JSON.stringify(body || {}) });
    let passphrase = requestPassphrase();
    while (passphrase) {
      try {
        return await api(path, options(passphrase));
      } catch (error) {
        if (error.status !== 401) throw error;
        passphrase = requestPassphrase();
      }
    }
    return null;
  }

  async function refreshRoster() {
    const button = document.getElementById('lottery-refresh-roster');
    const status = document.getElementById('lottery-roster-status');
    button.disabled = true;
    status.textContent = 'Checking Sleeper for the current league managers…';
    try {
      const [usersResponse, rostersResponse] = await Promise.all([
        fetch(`https://api.sleeper.app/v1/league/${sleeperLeagueId}/users`),
        fetch(`https://api.sleeper.app/v1/league/${sleeperLeagueId}/rosters`)
      ]);
      if (!usersResponse.ok || !rostersResponse.ok) throw new Error('Sleeper did not return the league roster.');
      const users = await usersResponse.json();
      const rosters = await rostersResponse.json();
      const userMap = new Map(users.map(user => [String(user.user_id), user]));
      const names = [...new Set(rosters.filter(roster => roster.owner_id).sort((a, b) => a.roster_id - b.roster_id).map(roster => {
        const user = userMap.get(String(roster.owner_id));
        const display = String((user && user.display_name) || '').trim();
        return sleeperAliases[display.toLowerCase()] || display || `Manager ${roster.roster_id}`;
      }))];
      const next = await admin('/roster', { roster: names });
      if (!next) return;
      applyState(next);
      status.textContent = `${names.length} managers refreshed from Sleeper at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      document.getElementById('lottery-draw-note').textContent = 'The current Sleeper managers are loaded and bouncing. Lock the date when ready.';
    } catch (error) {
      status.textContent = error.message || 'Could not reach Sleeper.';
    } finally {
      if (state) refreshLotteryScheduleUI();
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('#lottery-lock-date,#lottery-reset,#lottery-refresh-roster,#lottery-change-date');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (button.id === 'lottery-change-date') {
      if (!state || state.phase !== 'countdown') return;
      lotteryDateEditing = true;
      setError('');
      refreshLotteryScheduleUI();
      document.getElementById('lottery-date-input').focus();
      return;
    }
    if (button.id === 'lottery-lock-date') {
      const timestamp = new Date(document.getElementById('lottery-date-input').value).getTime();
      if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
        setError('Choose a future date and time before locking the machine.');
        return;
      }
      button.disabled = true;
      setError('');
      admin('/lock', { scheduleAt: timestamp, roster: lotteryRoster })
        .then(next => { if (next) applyState(next); })
        .catch(error => setError(error.message))
        .finally(() => { if (state) refreshLotteryScheduleUI(); });
      return;
    }
    if (button.id === 'lottery-reset') {
      if (!window.confirm('Reset the shared lottery date and order for every visitor?')) return;
      button.disabled = true;
      admin('/reset', {})
        .then(next => { if (next) { activeKey = ''; applyState(next); } })
        .catch(error => setError(error.message))
        .finally(() => { if (state) refreshLotteryScheduleUI(); });
      return;
    }
    refreshRoster();
  }, true);

  // The legacy reset listener is device-only. Replace that button so every
  // reset flows through the protected shared-state listener above.
  const legacyResetButton = document.getElementById('lottery-reset');
  if (legacyResetButton) {
    const protectedResetButton = legacyResetButton.cloneNode(true);
    legacyResetButton.replaceWith(protectedResetButton);
  }

  window.setLotteryActive = active => {
    lotterySchedule = null;
    lotteryResults = [];
    lotteryNames = [...lotteryRoster];
    lotteryPickNum = 1;
    lotteryPhase = 'waiting';
    originalSetLotteryActive(active);
    if (lotteryClock) {
      clearInterval(lotteryClock);
      lotteryClock = null;
    }
    if (active) startPolling(); else stopPolling();
  };

  if (legacySchedule) {
    const input = document.getElementById('lottery-date-input');
    if (input) input.value = localInputValue(new Date(legacySchedule));
  }
})();
