'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open, Protocol } = require('node-simconnect');

let connectionPromise;
let latestPlan;
const EVENT_FLIGHT_PLAN_ACTIVATED = 0xFF2F5001;
const EVENT_SIM_STATE = 0xFF2F5002;

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

function readFields(bytes) {
  const fields = [];
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
      if (offset + 8 > bytes.length) break;
      value = bytes.subarray(offset, offset + 8);
      offset += 8;
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.next;
      // ForeFlight sometimes omits an optional final fixed32 field while
      // retaining its nominal message length. Preserve the available part.
      const end = Math.min(offset + Number(length.value), bytes.length);
      value = bytes.subarray(offset, end);
      offset = end;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) break;
      value = bytes.subarray(offset, offset + 4);
      offset += 4;
    } else {
      break;
    }
    fields.push({ number, wireType, value });
  }
  return fields;
}

function first(fields, number) {
  return fields.find((field) => field.number === number);
}

function text(field) {
  return field?.wireType === 2 ? field.value.toString('utf8') : undefined;
}

function numberValue(field) {
  return field?.wireType === 0 ? Number(field.value) : undefined;
}

function extractWaypoints(payload) {
  // The first four bytes are a ForeFlight envelope. The actual FlightPlan
  // protobuf begins with the plan name at byte four.
  const planFields = readFields(payload.subarray(4));
  return planFields
    .filter((field) => field.number === 3 && field.wireType === 2)
    .map((field) => {
      const waypoint = readFields(field.value);
      const positionField = first(waypoint, 2);
      const position = positionField?.wireType === 2 ? readFields(positionField.value) : [];
      const latitude = first(position, 1)?.value?.readFloatLE(0);
      const longitude = first(position, 2)?.value?.readFloatLE(0);
      return {
        ident: text(first(waypoint, 1)),
        name: text(first(waypoint, 4)),
        type: numberValue(first(waypoint, 3)),
        latitude,
        longitude,
      };
    })
    .filter((waypoint) => waypoint.ident && Number.isFinite(waypoint.latitude) && Number.isFinite(waypoint.longitude));
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function worldPosition(latitude, longitude) {
  function dms(value, positive, negative) {
    const absolute = Math.abs(value);
    const degrees = Math.floor(absolute);
    const minutesTotal = (absolute - degrees) * 60;
    const minutes = Math.floor(minutesTotal);
    const seconds = ((minutesTotal - minutes) * 60).toFixed(2);
    return `${value >= 0 ? positive : negative}${degrees}° ${minutes}' ${seconds}"`;
  }
  return `${dms(latitude, 'N', 'S')},${dms(longitude, 'E', 'W')},+000000.00`;
}

function flightPlanXml(waypoints, title) {
  const departure = waypoints[0];
  const destination = waypoints.at(-1);
  const entries = waypoints.map((waypoint, index) => {
    const isAirport = index === 0 || index === waypoints.length - 1;
    const id = isAirport ? waypoint.ident : `${waypoint.ident}-${index}`;
    const icao = isAirport ? `\n      <ICAO><ICAOIdent>${xml(waypoint.ident)}</ICAOIdent></ICAO>` : '';
    // Intermediate points are represented as coordinates. This is safer than
    // asserting ICAO metadata for user fixes, holds, or ambiguous navaids.
    return `    <ATCWaypoint id="${xml(id)}">
      <ATCWaypointType>${isAirport ? 'Airport' : 'User'}</ATCWaypointType>
      <WorldPosition>${worldPosition(waypoint.latitude, waypoint.longitude)}</WorldPosition>${icao}
    </ATCWaypoint>`;
  }).join('\n');
  const safeTitle = `${departure.ident} to ${destination.ident}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
  <Descr>AceXML Document</Descr>
  <FlightPlan.FlightPlan>
    <Title>${xml(safeTitle)}</Title>
    <FPType>VFR</FPType>
    <RouteType>Direct</RouteType>
    <CruisingAlt>0</CruisingAlt>
    <DepartureID>${xml(departure.ident)}</DepartureID>
    <DepartureLLA>${worldPosition(departure.latitude, departure.longitude)}</DepartureLLA>
    <DestinationID>${xml(destination.ident)}</DestinationID>
    <DestinationLLA>${worldPosition(destination.latitude, destination.longitude)}</DestinationLLA>
    <Descr>${xml(title || safeTitle)}</Descr>
    <DeparturePosition>NONE</DeparturePosition>
    <DepartureName>${xml(departure.name || departure.ident)}</DepartureName>
    <DestinationName>${xml(destination.name || destination.ident)}</DestinationName>
    <AppVersion><AppVersionMajor>12</AppVersionMajor></AppVersion>
${entries}
  </FlightPlan.FlightPlan>
</SimBase.Document>
`;
}

async function simConnect() {
  if (!connectionPromise) {
    connectionPromise = open('FF2FS ForeFlight Bridge', Protocol.SunRise)
      .then(({ recvOpen, handle }) => {
        console.log(`MSFS connected: ${recvOpen.applicationName} ${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor}`);
        const reset = () => { connectionPromise = undefined; };
        handle.on('exception', (exception) => {
          console.error(`MSFS SimConnect exception: ${exception.exceptionName} (code ${exception.exception}, packet ${exception.sendId}, index ${exception.index}).`);
        });
        handle.on('eventFilename', (event) => {
          if (event.clientEventId === EVENT_FLIGHT_PLAN_ACTIVATED) {
            console.log(`MSFS confirmed FlightPlanActivated: ${event.fileName || '(no filename returned)'}.`);
          }
        });
        handle.on('event', (event) => {
          if (event.clientEventId === EVENT_SIM_STATE) {
            console.log(`MSFS simulation state: ${event.data ? 'running' : 'not running'}.`);
          }
        });
        try {
          console.log(`MSFS subscribed to FlightPlanActivated (packet ${handle.subscribeToSystemEvent(EVENT_FLIGHT_PLAN_ACTIVATED, 'FlightPlanActivated')}).`);
          console.log(`MSFS subscribed to Sim state (packet ${handle.subscribeToSystemEvent(EVENT_SIM_STATE, 'Sim')}).`);
        } catch (error) {
          console.error(`MSFS event subscription failed: ${error.message}`);
        }
        handle.once('quit', () => { console.log('MSFS sent quit notification.'); reset(); });
        handle.once('close', () => { console.log('MSFS SimConnect connection closed.'); reset(); });
        handle.once('error', (error) => console.error(`MSFS SimConnect socket error: ${error.message}`));
        return handle;
      })
      .catch((error) => {
        connectionPromise = undefined;
        throw error;
      });
  }
  return connectionPromise;
}

async function writeAndLoadFlightPlan(payload, routeString) {
  const waypoints = extractWaypoints(payload);
  if (waypoints.length < 2) throw new Error('Received route has fewer than two navigable waypoints');
  // Retain the decoded plan in process. The EFB bridge reads this directly;
  // no workspace artifacts are created during ordinary route synchronization.
  latestPlan = {
    revision: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    receivedAt: new Date().toISOString(),
    routeString: routeString || `${waypoints[0].ident} to ${waypoints.at(-1).ident}`,
    waypoints: waypoints.map(({ ident, name, type, latitude, longitude }) => ({
      ident,
      name: name || ident,
      type,
      latitude,
      longitude,
    })),
  };
  console.log(`MSFS decoded plan ready for EFB route synchronization (${waypoints.length} waypoint(s)).`);

  // Do not load automatically while validating route fidelity. A malformed
  // flight-plan file can destabilize MSFS avionics. Explicit opt-in keeps the
  // ForeFlight receiver safe while preserving the generated .PLN for review.
  if (process.env.FF2FS_MSFS_LOAD === '0') {
    console.log('SimConnect FlightPlanLoad is disabled by FF2FS_MSFS_LOAD=0; awaiting the EFB route bridge.');
    return { waypoints, dispatched: false };
  }

  const directory = path.join(os.tmpdir(), 'FF2FS', 'plans');
  fs.mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const planPath = path.join(directory, `${timestamp}-${waypoints[0].ident}-to-${waypoints.at(-1).ident}.PLN`);
  fs.writeFileSync(planPath, flightPlanXml(waypoints, routeString || `${waypoints[0].ident} to ${waypoints.at(-1).ident}`));
  console.log(`Diagnostic SimConnect plan written: ${planPath} (${fs.statSync(planPath).size} bytes).`);

  console.log(`MSFS FlightPlanLoad preparing absolute path: ${path.resolve(planPath)}`);
  const handle = await simConnect();
  const sendId = handle.flightPlanLoad(planPath);
  // FlightPlanLoad has no completion callback. FlightPlanActivated and any
  // SimConnect exception are logged above to provide the best available proof.
  console.log(`MSFS FlightPlanLoad dispatched (packet ${sendId}) for ${waypoints.length} waypoint(s); waiting for FlightPlanActivated or an exception.`);
  return { planPath, waypoints, dispatched: true };
}

function getLatestPlan() {
  return latestPlan;
}

module.exports = { writeAndLoadFlightPlan, getLatestPlan, extractWaypoints, flightPlanXml };
