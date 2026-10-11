'use strict';

const state = {
  startedAt: new Date().toISOString(),
  receiver: { running: true, detail: 'Starting receiver' },
  foreFlight: { connected: false, detail: 'Waiting for ForeFlight discovery' },
  msfs: { connected: false, detail: 'Waiting for the MSFS EFB bridge' },
  lastPlan: undefined,
};

function update(section, connected, detail) {
  state[section] = { connected, detail, updatedAt: new Date().toISOString() };
}

function plan(route, waypointCount) {
  state.lastPlan = { route, waypointCount, receivedAt: new Date().toISOString() };
}

function snapshot() {
  return { ...state, now: new Date().toISOString() };
}

module.exports = { update, plan, snapshot };
