'use strict';

// A separate ForeFlight GDL90 device. This deliberately has no OANP identity:
// the OANP receiver is the FF2FS panel, while this socket supplies GPS,
// AHRS, air data, and (later) traffic.
const dgram = require('node:dgram');
const {
  open, Protocol, SimConnectConstants, SimConnectDataType, SimConnectPeriod,
} = require('node-simconnect');

const DEFINITION_ID = 0xFF2F5201;
const REQUEST_ID = 0xFF2F5202;
const GPS_RATE_MS = 500;
const AHRS_RATE_MS = 200;
const SECOND_RATE_MS = 1000;
const ICAO = 0xABCDEF;

let targetProvider = () => [];
let started = false;
let handle;
let reconnectTimer;
let lastHeartbeat = 0;
let lastPosition = 0;
let lastGeoAltitude = 0;
let lastDeviceInfo = 0;
let lastAhrs = 0;
let lastLog = 0;

// Do not bind this socket. Windows assigns an ephemeral source port on the
// first send, exactly as a physical GDL90 device bridge does.
const socket = dgram.createSocket('udp4');
socket.on('error', (error) => console.error(`GDL90 socket error: ${error.message}`));

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function crc16(bytes) {
  // This is the GDL90 encoder's table update rule. It is not interchangeable
  // with the commonly copied CRC-CCITT bit-loop variant.
  const tableEntry = (value) => {
    let crc = value << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    return crc;
  };
  let crc = 0;
  for (const byte of bytes) crc = tableEntry(crc >>> 8) ^ ((crc << 8) & 0xffff) ^ byte;
  return crc;
}

function frame(payload) {
  const crc = crc16(payload);
  const source = Buffer.concat([payload, Buffer.from([crc & 0xff, crc >>> 8])]);
  const output = [0x7e];
  for (const byte of source) {
    if (byte === 0x7d || byte === 0x7e) output.push(0x7d, byte ^ 0x20);
    else output.push(byte);
  }
  output.push(0x7e);
  return Buffer.from(output);
}

function fixed(value, width) {
  const result = Buffer.alloc(width, 0);
  Buffer.from(value, 'ascii').copy(result, 0, 0, width);
  return result;
}

function heartbeat() {
  const seconds = Math.floor(Date.now() / 1000) % 86400;
  return frame(Buffer.from([
    0x00, 0x81, 0x01 | ((seconds & 0x10000) ? 0x80 : 0x00),
    seconds & 0xff, (seconds >>> 8) & 0xff, 0x00, 0x00,
  ]));
}

function ownship(data) {
  const payload = Buffer.alloc(28, 0);
  payload[0] = 0x0a;
  payload[1] = 0x00; // ADS-B/ICAO address type
  payload[2] = (ICAO >>> 16) & 0xff;
  payload[3] = (ICAO >>> 8) & 0xff;
  payload[4] = ICAO & 0xff;
  payload.writeIntBE(clamp(Math.trunc(data.latitude * 0x800000 / 180), -0x800000, 0x7fffff), 5, 3);
  payload.writeIntBE(clamp(Math.trunc(data.longitude * 0x800000 / 180), -0x800000, 0x7fffff), 8, 3);
  const altitude = clamp(Math.trunc((data.pressureAltitude + 1000) / 25), 0, 0xffe);
  payload[11] = altitude >>> 4;
  payload[12] = ((altitude & 0x0f) << 4) | ((data.onGround ? 0 : 1) << 3) | 0x01;
  payload[13] = 0xbb; // NIC 11 / NACp 11
  const speed = clamp(Math.trunc(Math.max(0, data.groundSpeed)), 0, 0xffe);
  const vertical = clamp(Math.trunc(data.verticalSpeedFps * 60 / 64), -512, 511) & 0x0fff;
  payload[14] = speed >>> 4;
  payload[15] = ((speed & 0x0f) << 4) | (vertical >>> 8);
  payload[16] = vertical & 0xff;
  payload[17] = Math.trunc(((data.trueHeading % 360 + 360) % 360) * 256 / 360) & 0xff;
  payload[18] = 0x01;
  Buffer.from('N12345  ', 'ascii').copy(payload, 19);
  return frame(payload);
}

function geoAltitude(data) {
  const payload = Buffer.alloc(5);
  payload[0] = 0x0b;
  payload.writeInt16BE(clamp(Math.round(data.altitude / 5), -32768, 32767), 1);
  payload.writeUInt16BE(0x7fff, 3);
  return frame(payload);
}

function deviceInfo() {
  const payload = Buffer.alloc(39, 0);
  payload[0] = 0x65;
  payload[1] = 0x00;
  payload[2] = 0x01;
  payload.fill(0xff, 3, 11);
  // GDL90 provides an eight-character short name and a 16-character display
  // name. ForeFlight uses the latter in its connected-device UI.
  fixed('FF2FS', 8).copy(payload, 11);
  fixed('FF2FS-GDL90', 16).copy(payload, 19);
  payload.writeUInt32BE(1, 35); // geometric altitude is MSL
  return frame(payload);
}

function ahrs(data) {
  const int16 = (value) => clamp(Math.round(value), -32768, 32767);
  const uint16 = (value) => clamp(Math.trunc(value), 0, 65534);
  const heading = ((data.trueHeading % 360) + 360) % 360;
  const payload = Buffer.alloc(12);
  payload[0] = 0x65;
  payload[1] = 0x01;
  payload.writeInt16BE(int16(data.bank * 10), 2);
  payload.writeInt16BE(int16(data.pitch * 10), 4);
  payload.writeUInt16BE(uint16(heading * 10), 6);
  payload.writeUInt16BE(uint16(data.indicatedAirspeed), 8);
  payload.writeUInt16BE(uint16(data.trueAirspeed), 10);
  return frame(payload);
}

function send(packet) {
  for (const target of targetProvider()) {
    socket.send(packet, target.gdl90Port, target.address, (error) => {
      if (error) console.error(`GDL90 send to ${target.address}:${target.gdl90Port} failed: ${error.message}`);
    });
  }
}

function sendDue(data, now) {
  // Preserve the accepted registration sequence: heartbeat, position,
  // geometric altitude, identity, attitude.
  if (now - lastHeartbeat >= SECOND_RATE_MS) {
    lastHeartbeat = now;
    send(heartbeat());
  }
  if (now - lastPosition >= GPS_RATE_MS) {
    lastPosition = now;
    send(ownship(data));
  }
  if (now - lastGeoAltitude >= SECOND_RATE_MS) {
    lastGeoAltitude = now;
    send(geoAltitude(data));
  }
  if (now - lastDeviceInfo >= SECOND_RATE_MS) {
    lastDeviceInfo = now;
    send(deviceInfo());
  }
  if (now - lastAhrs >= AHRS_RATE_MS) {
    lastAhrs = now;
    send(ahrs(data));
  }
  if (now - lastLog >= 5000 && Array.from(targetProvider()).length) {
    lastLog = now;
    console.log(`FF2FS GDL90: ${data.latitude.toFixed(5)},${data.longitude.toFixed(5)}; ${data.trueHeading.toFixed(1)}°.`);
  }
}

function configure(sim) {
  const fields = [
    ['PLANE LATITUDE', 'degrees', SimConnectDataType.FLOAT64],
    ['PLANE LONGITUDE', 'degrees', SimConnectDataType.FLOAT64],
    ['PLANE ALTITUDE', 'feet', SimConnectDataType.FLOAT64],
    ['PRESSURE ALTITUDE', 'feet', SimConnectDataType.FLOAT64],
    ['GROUND VELOCITY', 'knots', SimConnectDataType.FLOAT64],
    ['VERTICAL SPEED', 'feet per second', SimConnectDataType.FLOAT64],
    ['PLANE HEADING DEGREES TRUE', 'degrees', SimConnectDataType.FLOAT64],
    ['PLANE HEADING DEGREES MAGNETIC', 'degrees', SimConnectDataType.FLOAT64],
    ['PLANE PITCH DEGREES', 'degrees', SimConnectDataType.FLOAT64],
    ['PLANE BANK DEGREES', 'degrees', SimConnectDataType.FLOAT64],
    ['AIRSPEED INDICATED', 'knots', SimConnectDataType.FLOAT64],
    ['AIRSPEED TRUE', 'knots', SimConnectDataType.FLOAT64],
    ['SIM ON GROUND', 'Bool', SimConnectDataType.INT32],
  ];
  for (const [name, unit, type] of fields) sim.addToDataDefinition(DEFINITION_ID, name, unit, type, 0, SimConnectConstants.UNUSED);
  sim.requestDataOnSimObject(REQUEST_ID, DEFINITION_ID, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME);
}

function decode(buffer) {
  return {
    latitude: buffer.readFloat64(), longitude: buffer.readFloat64(), altitude: buffer.readFloat64(),
    pressureAltitude: buffer.readFloat64(), groundSpeed: buffer.readFloat64(), verticalSpeedFps: buffer.readFloat64(),
    trueHeading: buffer.readFloat64(), magneticHeading: buffer.readFloat64(), pitch: buffer.readFloat64(),
    bank: buffer.readFloat64(), indicatedAirspeed: buffer.readFloat64(), trueAirspeed: buffer.readFloat64(),
    onGround: buffer.readInt32() !== 0,
  };
}

function connect() {
  open('FF2FS GDL90', Protocol.SunRise).then(({ recvOpen, handle: openedHandle }) => {
    handle = openedHandle;
    console.log(`FF2FS GDL90 connected to MSFS: ${recvOpen.applicationName} ${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}`);
    configure(handle);
    handle.on('simObjectData', (event) => {
      if (event.requestID !== REQUEST_ID || event.data.remaining() < 100) return;
      const data = decode(event.data);
      if (![data.latitude, data.longitude, data.altitude, data.pressureAltitude, data.trueHeading].every(Number.isFinite)) return;
      sendDue(data, Date.now());
    });
    const reconnect = () => {
      if (handle !== openedHandle) return;
      handle = undefined;
      if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 5000);
    };
    handle.once('quit', reconnect);
    handle.once('close', reconnect);
    handle.once('error', (error) => { console.error(`FF2FS GDL90 SimConnect error: ${error.message}`); reconnect(); });
  }).catch((error) => {
    console.log(`FF2FS GDL90 waiting for MSFS: ${error.message}`);
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = undefined; connect(); }, 5000);
  });
}

function start(provider) {
  if (started) return;
  started = true;
  targetProvider = provider;
  console.log('FF2FS GDL90 telemetry device starting.');
  connect();
}

module.exports = { start };
