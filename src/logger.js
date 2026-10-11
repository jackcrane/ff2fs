'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep logs in the real user Temp directory rather than an AppContainer Temp
// redirect, so Explorer can open the same folder the receiver writes to.
const userTemp = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : os.tmpdir();
const LOG_DIRECTORY = path.join(userTemp, 'FF2FS', 'logs');
fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
const logPath = path.join(LOG_DIRECTORY, `ff2fs-${new Date().toISOString().slice(0, 10)}.log`);
const originalConsole = { log: console.log.bind(console), error: console.error.bind(console), warn: console.warn.bind(console) };

function format(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function write(level, values) {
  const line = `${new Date().toISOString()} [${level}] ${values.map(format).join(' ')}\n`;
  try { fs.appendFileSync(logPath, line, 'utf8'); } catch { /* Console remains usable if Temp is unavailable. */ }
}

function installConsoleFileLogging() {
  for (const level of ['log', 'error', 'warn']) {
    console[level] = (...values) => {
      write(level.toUpperCase(), values);
      originalConsole[level](...values);
    };
  }
  console.log(`Detailed log file: ${logPath}`);
}

module.exports = { LOG_DIRECTORY, logPath, installConsoleFileLogging };
