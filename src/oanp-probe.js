'use strict';

const dgram = require('node:dgram');
const net = require('node:net');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { writeAndLoadFlightPlan, getLatestPlan } = require('./msfs-bridge');

const DISCOVERY_PORT = 63093;
// SkyView's own get_heartbeat() stores 0x20c0 here: TCP/UDP 8384.  Its
// unrelated GDL90 telemetry port is 4000.
const OANP_PORT = 8384;
// ForeFlight 18.7 selects this transfer socket after receiving the SkyView
// OANP heartbeat. Keep the published SkyView service on 8384 too, but accept
// its compatibility transaction channel as well.
const FORE_FLIGHT_TRANSFER_PORT = 64099;
const IN_SIM_BRIDGE_PORT = 64098;
const enableInSimBridge = process.env.FF2FS_EFB_BRIDGE === '1';
const targets = new Map();
// Bump the simulated endpoint identity whenever changing its wire contract.
// ForeFlight caches an endpoint's host/port by identity across heartbeats.
const SYSTEM_ID = 'FF2FS-SKYVIEW-002';
const ENDPOINT_UUID = '4e4f414e-502d-4646-3246-533030303032';

console.log(`MSFS FlightPlanLoad mode: ${process.env.FF2FS_MSFS_LOAD === '0' ? 'disabled by environment; using the EFB route bridge' : 'ENABLED alongside the EFB route bridge'}.`);

function localIPv4() {
  const interfaces = require('node:os').networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && entry.address.startsWith('192.168.1.')) return entry.address;
    }
  }
  return '127.0.0.1';
}

function varint(value) {
  const bytes = [];
  let current = value >>> 0;
  do {
    let byte = current & 0x7f;
    current >>>= 7;
    if (current) byte |= 0x80;
    bytes.push(byte);
  } while (current);
  return Buffer.from(bytes);
}

function field(number, wireType, value) {
  return Buffer.concat([varint((number << 3) | wireType), value]);
}
function stringField(number, value) {
  const bytes = Buffer.from(value, 'utf8');
  return field(number, 2, Buffer.concat([varint(bytes.length), bytes]));
}
function boolField(number, value) {
  return field(number, 0, varint(value ? 1 : 0));
}
function messageField(number, value) {
  return field(number, 2, Buffer.concat([varint(value.length), value]));
}

function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  for (let index = offset; index < bytes.length && index < offset + 10; index += 1) {
    const byte = bytes[index];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: index + 1 };
    shift += 7n;
  }
  throw new Error('Malformed protobuf varint');
}

function decodeProtobuf(bytes) {
  const fields = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const key = readVarint(bytes, offset);
    offset = key.next;
    const number = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    let value;
    if (wireType === 0) {
      const parsed = readVarint(bytes, offset);
      value = parsed.value;
      offset = parsed.next;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new Error('Truncated fixed64 field');
      value = bytes.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.next;
      const end = offset + Number(length.value);
      if (end > bytes.length) throw new Error('Truncated length-delimited field');
      value = bytes.subarray(offset, end);
      offset = end;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new Error('Truncated fixed32 field');
      value = bytes.subarray(offset, offset + 4);
      offset += 4;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
    const entry = { wireType, value };
    const values = fields.get(number) || [];
    values.push(entry);
    fields.set(number, values);
  }
  return fields;
}

function firstField(fields, number) {
  return fields.get(number)?.[0];
}
function asNumber(entry) {
  return entry ? Number(entry.value) : undefined;
}
function asText(entry) {
  return entry ? entry.value.toString('utf8') : undefined;
}
function asDouble(entry) {
  return entry?.wireType === 1 ? entry.value.readDoubleLE(0) : undefined;
}

function decodeFlightPlan(payload) {
  const plan = decodeProtobuf(payload);
  const waypoints = (plan.get(3) || []).map(({ value }) => {
    const waypoint = decodeProtobuf(value);
    const geo = firstField(waypoint, 2);
    const point = geo ? decodeProtobuf(geo.value) : new Map();
    return {
      ident: asText(firstField(waypoint, 1)),
      latitude: asDouble(firstField(point, 1)),
      longitude: asDouble(firstField(point, 2)),
      waypointType: asNumber(firstField(waypoint, 3)),
      name: asText(firstField(waypoint, 4)),
      elevation: asNumber(firstField(waypoint, 5)),
      crossingAltitude: asNumber(firstField(waypoint, 6)),
      crossingConstraint: asNumber(firstField(waypoint, 7)),
    };
  });
  return {
    name: asText(firstField(plan, 1)),
    activeIndex: asNumber(firstField(plan, 2)),
    userVisibleAppName: asText(firstField(plan, 4)),
    waypoints,
  };
}

function routeStringFromFlightPlan(payload) {
  // ForeFlight precedes its protobuf with four opaque bytes. Its final
  // waypoint may also omit an optional fixed32 tail while retaining the
  // nominal length, so use a tolerant reader for display-only extraction.
  const plan = payload.subarray(4);
  const identifiers = [];
  let offset = 0;
  while (offset < plan.length) {
    let key;
    let length;
    try {
      ({ value: key, next: offset } = readVarint(plan, offset));
      const wireType = Number(key & 7n);
      const fieldNumber = Number(key >> 3n);
      if (wireType === 0) {
        ({ next: offset } = readVarint(plan, offset));
        continue;
      }
      if (wireType === 1) { offset += 8; continue; }
      if (wireType === 5) { offset += 4; continue; }
      if (wireType !== 2) break;
      ({ value: length, next: offset } = readVarint(plan, offset));
      const end = Math.min(offset + Number(length), plan.length);
      const value = plan.subarray(offset, end);
      offset = end;
      if (fieldNumber !== 3) continue;

      // A waypoint starts with field 1 (identifier). Decode only that field,
      // avoiding optional fields later in its truncated tail.
      let waypointOffset = 0;
      const identKey = readVarint(value, waypointOffset);
      waypointOffset = identKey.next;
      if (Number(identKey.value >> 3n) !== 1 || Number(identKey.value & 7n) !== 2) continue;
      const identLength = readVarint(value, waypointOffset);
      waypointOffset = identLength.next;
      const ident = value.subarray(waypointOffset, waypointOffset + Number(identLength.value)).toString('utf8');
      if (ident) identifiers.push(ident);
    } catch {
      break;
    }
  }
  return identifiers.join(' → ');
}

function saveFlightPlan(payload, remote) {
  // The leading fixed32 field is part of PB_Data_FlightPlan, not a transport
  // wrapper. Preserve the complete protobuf so the last waypoint is intact.
  const planPayload = payload;
  const receivedAt = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const folder = path.join(process.cwd(), 'received-plans');
  fs.mkdirSync(folder, { recursive: true });
  const base = path.join(folder, `${receivedAt}-${remote.address.replaceAll(':', '_')}`);
  fs.writeFileSync(`${base}.pb`, planPayload);
  let plan;
  let parseError;
  let routeString;
  try {
    plan = decodeFlightPlan(planPayload);
  } catch (error) {
    // Retain the exact protobuf and acknowledge the transfer even if a newer
    // ForeFlight waypoint extension is not yet represented by our reader.
    parseError = error.message;
  }
  try {
    routeString = routeStringFromFlightPlan(planPayload);
  } catch (error) {
    parseError ||= error.message;
  }
  fs.writeFileSync(`${base}.json`, `${JSON.stringify({
    receivedAt: new Date().toISOString(),
    source: remote,
    routeString,
    plan,
    parseError,
  }, null, 2)}\n`);
  console.log(`Route: ${routeString || '(waypoint identifiers unavailable)'}`);
  if (plan) console.log(`Flight plan received: ${plan.name || '(unnamed)'} — ${plan.waypoints.length} waypoint(s)`);
  else console.log(`Flight plan received and saved as raw protobuf (decoder note: ${parseError}).`);
  console.log(`Saved ${base}.json and ${base}.pb`);
  writeAndLoadFlightPlan(payload, routeString).catch((error) => {
    console.error(`MSFS route processing skipped: ${error.message}`);
  });
}

function heartbeatPayload() {
  // Exact PB_Heartbeat field numbers recovered from SkyView 16.7.8's generated
  // protobuf constants in /app/ampm.build.exe.
  const capabilities = Buffer.concat([
    boolField(1, true), // status
    boolField(2, true), // GPS
    boolField(3, true), // AHRS
    boolField(4, true), // ADAHRS
    boolField(5, true), // flight-plan transmit
    boolField(6, true)  // flight-plan receive
  ]);
  return Buffer.concat([
    stringField(1, SYSTEM_ID),             // system ID
    field(2, 0, varint(Math.floor(Date.now() / 1000))), // timestamp
    stringField(3, localIPv4()),        // endpoint IP address
    field(4, 0, varint(OANP_PORT)),      // endpoint TCP/UDP port (uint32)
    boolField(5, true),                  // this endpoint is an EFIS/panel
    messageField(6, capabilities),
    stringField(7, 'Dynon Avionics, Inc.'),
    stringField(8, 'SkyView'),
    stringField(9, 'D1000/D700'),
    stringField(10, 'FF2FS-002'),
    stringField(11, '16.7.8'),
    stringField(12, 'SkyView-FF2FS')
  ]);
}

function broadcastMessage() {
  // Exact PB_BcastMsg field numbers: system_id, endpoint_uuid, msg_type,
  // heartbeat. Heartbeat's enum value is 1.
  return Buffer.concat([
    stringField(1, SYSTEM_ID),
    stringField(2, ENDPOINT_UUID),
    field(3, 0, varint(1)),
    messageField(4, heartbeatPayload())
  ]);
}

// ForeFlight emits its discovery probe on 63093, but a real SkyView's OANP
// heartbeats originate from 8384.  Keep these as distinct UDP sockets: using
// the discovery socket to send heartbeats makes the source port 63093, which
// lets ForeFlight display a cached panel but rejects it before transfer.
const discoveryUdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const oanpUdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

discoveryUdp.on('error', (error) => console.error(`Discovery UDP error: ${error.message}`));
oanpUdp.on('error', (error) => console.error(`OANP UDP error: ${error.message}`));
discoveryUdp.on('message', (message, remote) => {
  try {
    const beacon = JSON.parse(message.toString('utf8'));
    if (beacon?.App !== 'ForeFlight') return;
    const port = OANP_PORT;
    const key = `${remote.address}:${port}`;
    if (!targets.has(key)) console.log(`ForeFlight discovered at ${key}`);
    targets.set(key, { address: remote.address, port });
  } catch { /* OANP and other binary traffic is ignored here. */ }
});
discoveryUdp.bind(DISCOVERY_PORT, () => {
  console.log(`OANP probe listening for ForeFlight discovery on UDP ${DISCOVERY_PORT}.`);
});
oanpUdp.bind(OANP_PORT, '0.0.0.0', () => {
  oanpUdp.setBroadcast(true);
  console.log(`Advertising SkyView OANP heartbeat from ${localIPv4()}:${OANP_PORT}.`);
});

function createTcpServer(port) {
  const tcp = net.createServer((socket) => {
  console.log(`TCP ${port} connection from ${socket.remoteAddress}:${socket.remotePort}`);
  let buffered = Buffer.alloc(0);
  let requestLength;
  let request;
  let payloadLength;
  let framedPayloadLength;
  let replied = false;

  function replySuccess() {
    if (replied) return;
    replied = true;
    // PB_Data_TransactionReply: TransactionReplyType_Success = 1.
    const reply = Buffer.from([0x08, 0x01]);
    const frame = Buffer.alloc(4 + reply.length);
    frame.writeUInt32BE(reply.length, 0);
    reply.copy(frame, 4);
    socket.end(frame);
  }

  function consume() {
    if (requestLength === undefined) {
      if (buffered.length < 4) return;
      requestLength = buffered.readUInt32BE(0);
      buffered = buffered.subarray(4);
      if (requestLength > 0x2000) throw new Error(`Request length ${requestLength} exceeds OANP limit`);
    }
    if (!request) {
      if (buffered.length < requestLength) return;
      request = buffered.subarray(0, requestLength);
      buffered = buffered.subarray(requestLength);
      const transaction = decodeProtobuf(request);
      const type = asNumber(firstField(transaction, 1));
      payloadLength = asNumber(firstField(transaction, 2)) || 0;
      console.log(`OANP transaction type=${type ?? 'missing'}, payload=${payloadLength} bytes`);
      if (payloadLength > 0x2000) throw new Error(`Payload length ${payloadLength} exceeds OANP limit`);
      if (payloadLength === 0) {
        replySuccess();
        return;
      }
    }
    // OANP frames the transaction protobuf and its payload independently.
    // The request declares the expected payload length, then the wire carries
    // that length again as a 4-byte network-order frame before the payload.
    if (framedPayloadLength === undefined) {
      if (buffered.length < 4) return;
      framedPayloadLength = buffered.readUInt32BE(0);
      buffered = buffered.subarray(4);
      if (framedPayloadLength !== payloadLength) {
        throw new Error(`Payload frame length ${framedPayloadLength} does not match transaction length ${payloadLength}`);
      }
    }
    if (buffered.length < framedPayloadLength) return;
    const payload = buffered.subarray(0, framedPayloadLength);
    const transaction = decodeProtobuf(request);
    const type = asNumber(firstField(transaction, 1));
    if (type === 2) {
      saveFlightPlan(payload, {
        address: socket.remoteAddress || 'unknown',
        port: socket.remotePort,
      });
    }
    else console.log(`Saved no artifact: transaction type ${type} is not FlightPlan_Push.`);
    replySuccess();
  }

  socket.on('data', (data) => {
    try {
      const preview = data.subarray(0, 96);
      console.log(`TCP ${port} received ${data.length} byte(s): ${preview.toString('hex')}`);
      buffered = Buffer.concat([buffered, data]);
      consume();
    } catch (error) {
      console.error(`TCP ${port} protocol error: ${error.message}`);
      socket.destroy();
    }
  });
  socket.on('error', (error) => console.log(`TCP error: ${error.message}`));
  });
  tcp.on('error', (error) => console.error(`TCP ${port} listen error: ${error.message}`));
  tcp.listen(port, '0.0.0.0', () => console.log(`TCP listener ready on ${port}.`));
  return tcp;
}

// SkyView announces 8384. Port 4000 is also kept open because ForeFlight's
// Wi-Fi beacon advertises it; the first incoming TCP connection identifies
// which endpoint ForeFlight uses for the transfer transaction.
const tcpServers = [OANP_PORT, 4000, FORE_FLIGHT_TRANSFER_PORT].map(createTcpServer);

// Local endpoint consumed by the in-sim EFB bridge. It is opt-in so that the
// receiver can still be used as a ForeFlight-only tool when MSFS is absent.
const inSimBridgeServer = enableInSimBridge ? http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS') {
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/bridge-status') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2048) request.destroy();
    });
    request.on('end', () => {
      try {
        const status = JSON.parse(body);
        console.log(`[MSFS route bridge] ${status.level || 'info'}: ${status.message || 'status update'}`);
      } catch {
        console.log('[MSFS route bridge] sent an unreadable status update.');
      }
      response.writeHead(204).end();
    });
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  if (request.url !== '/v1/flight-plan') {
    response.writeHead(404).end();
    return;
  }
  const plan = getLatestPlan();
  if (!plan) {
    response.writeHead(204).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(plan));
}) : undefined;
if (inSimBridgeServer) {
  inSimBridgeServer.on('error', (error) => console.error(`MSFS route bridge HTTP error: ${error.message}`));
  inSimBridgeServer.listen(IN_SIM_BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`MSFS EFB route bridge API ready on http://127.0.0.1:${IN_SIM_BRIDGE_PORT}/v1/flight-plan.`);
  });
} else {
  console.log('In-sim EFB route bridge is disabled; using native SimConnect only.');
}

setInterval(() => {
  const packet = broadcastMessage();
  oanpUdp.send(packet, OANP_PORT, '255.255.255.255');
  for (const target of targets.values()) oanpUdp.send(packet, target.port, target.address);
}, 1000).unref();

process.on('SIGINT', () => {
  discoveryUdp.close();
  oanpUdp.close();
  for (const tcp of tcpServers) tcp.close();
  inSimBridgeServer?.close();
});
