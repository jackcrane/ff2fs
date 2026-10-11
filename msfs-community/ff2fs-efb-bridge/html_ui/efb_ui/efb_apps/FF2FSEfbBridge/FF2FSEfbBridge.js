/*
 * FF2FS EFB route bridge.
 *
 * Runs in the simulator EFB, not in a particular avionics package. The
 * FlightPlanRouteManager is MSFS 2024's avionics-agnostic route API, which
 * lets the simulator synchronize the EFB, ATC, and compatible instruments.
 */
(function (sdk) {
  'use strict';

  const PLAN_URL = 'http://127.0.0.1:64098/v1/flight-plan';
  const STATUS_URL = 'http://127.0.0.1:64098/v1/bridge-status';
  const POLL_INTERVAL_MS = 1500;
  const BUILD = '2026-10-11-efb-route-manager';

  function report(level, message) {
    fetch(STATUS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ level, message: `[EFB] ${message}` }),
    }).catch(() => {});
  }

  function validatePlan(plan) {
    if (!plan || !Array.isArray(plan.waypoints) || plan.waypoints.length < 2) {
      throw new Error('FF2FS plan has fewer than two waypoints');
    }
    for (const waypoint of plan.waypoints) {
      if (!waypoint.ident || !Number.isFinite(waypoint.latitude) || !Number.isFinite(waypoint.longitude)) {
        throw new Error('FF2FS plan contains an invalid waypoint');
      }
    }
  }

  function routeAirport(ident) {
    return sdk.ICAO.value('A', '', '', String(ident).trim().toUpperCase());
  }

  async function resolveIntersection(facilityLoader, waypoint) {
    if (!facilityLoader || waypoint.type !== 7 || !waypoint.ident) return undefined;
    const ident = String(waypoint.ident).trim().toUpperCase();
    const candidates = await facilityLoader.searchByIdentWithIcaoStructs(
      sdk.FacilitySearchType.Intersection,
      ident,
      25,
    );
    if (!candidates || candidates.length === 0) return undefined;

    // Identifiers are not globally unique. Resolve each candidate and use the
    // facility nearest ForeFlight's supplied coordinates.
    const facilities = await Promise.all(candidates.map(async (icao) => {
      try {
        return {
          icao: icao,
          facility: await facilityLoader.getFacility(sdk.FacilityType.Intersection, icao),
        };
      } catch (error) { return undefined; }
    }));
    let best;
    let bestDistance = Infinity;
    for (const candidate of facilities) {
      const facility = candidate && candidate.facility;
      if (!facility || !Number.isFinite(facility.lat) || !Number.isFinite(facility.lon)) continue;
      const latitudeDelta = facility.lat - waypoint.latitude;
      const longitudeDelta = facility.lon - waypoint.longitude;
      const distance = latitudeDelta * latitudeDelta + longitudeDelta * longitudeDelta;
      if (distance < bestDistance) { best = candidate.icao; bestDistance = distance; }
    }
    // `facility.icao` is a legacy string. FlightPlanRouteManager instead
    // requires the JS_ICAO object returned by searchByIdentWithIcaoStructs.
    return best;
  }

  async function toEfbRoute(plan, facilityLoader) {
    validatePlan(plan);
    const route = sdk.FlightPlanRouteUtils.emptyRoute();
    const waypoints = plan.waypoints;
    route.departureAirport = routeAirport(waypoints[0].ident);
    const destination = waypoints[waypoints.length - 1];
    const hasAirportDestination = destination.type === 1;
    if (hasAirportDestination) route.destinationAirport = routeAirport(destination.ident);
    route.isVfr = true;

    // When the plan ends at a fix, that fix is an enroute terminator, not an
    // airport destination. Keeping it in enroute preserves KCVG -> GEENY.
    const lastEnrouteIndex = hasAirportDestination ? waypoints.length - 1 : waypoints.length;
    for (let index = 1; index < lastEnrouteIndex; index += 1) {
      const waypoint = waypoints[index];
      const leg = sdk.FlightPlanRouteUtils.emptyEnrouteLeg();
      const facility = await resolveIntersection(facilityLoader, waypoint);
      if (facility) {
        leg.fixIcao = facility;
        leg.hasLatLon = false;
      } else {
        // Use a coordinate fix only for an unknown/custom ForeFlight point.
        leg.hasLatLon = true;
        leg.lat = waypoint.latitude;
        leg.lon = waypoint.longitude;
      }
      route.enroute.push(leg);
    }
    return route;
  }

  class FF2FSEfbBridge {
    constructor() {
      this.name = 'FF2FS Route Bridge';
      this.icon = 'coui://html_ui/efb_ui/efb_os/Assets/icons/NoMargin/Route.svg';
      this.BootMode = 2; // HOT: install even if the EFB app is not opened.
      this.SuspendMode = 1; // SLEEP
      this.available = sdk.Subject.create(true);
      this.loadedRevision = undefined;
      this.loading = false;
      this.isReady = false;
    }

    get internalName() {
      return 'FF2FSEfbBridge';
    }

    async _install(context) {
      this.bus = context.bus;
      this.isReady = true;
      this.timer = window.setInterval(() => this.poll(), POLL_INTERVAL_MS);
      window.setTimeout(() => this.poll(), 1000);
      report('info', `plugin ${BUILD} installed; watching localhost for ForeFlight routes.`);
      try {
        if (!sdk.FacilityLoader || !sdk.FacilityRepository || !sdk.FacilitySearchType || !sdk.FacilityType) {
          throw new Error('MSFS facility resolver API is unavailable in this EFB context');
        }
        this.facilityLoader = new sdk.FacilityLoader(sdk.FacilityRepository.getRepository(this.bus));
        report('info', 'MSFS facility resolver is ready.');
      } catch (error) {
        this.facilityLoader = undefined;
        report('error', `facility resolver unavailable: ${error.message || error}`);
      }
    }

    render() {
      return null;
    }

    async poll() {
      if (this.loading) return;
      try {
        const response = await fetch(PLAN_URL, { cache: 'no-store' });
        if (response.status === 204) return;
        if (!response.ok) throw new Error(`bridge HTTP ${response.status}`);
        const plan = await response.json();
        if (!plan.revision || plan.revision === this.loadedRevision) return;
        this.loading = true;
        const route = await toEfbRoute(plan, this.facilityLoader);
        const manager = await sdk.FlightPlanRouteManager.getManager();
        await manager.sendRouteToAvionics(route);
        await manager.sendRouteToEfb(route);
        await manager.fileRouteWithAtc(route);
        this.loadedRevision = plan.revision;
        report('info', `synchronized ${plan.waypoints.length} waypoint(s) to avionics, EFB, and ATC: ${plan.routeString || ''}`);
      } catch (error) {
        report('error', `route synchronization failed: ${error.message || error}`);
      } finally {
        this.loading = false;
      }
    }
  }

  if (!window.EFB_API || !sdk.FlightPlanRouteManager || !sdk.FlightPlanRouteUtils || !sdk.ICAO) {
    console.warn('[FF2FS] EFB route API unavailable; global route bridge did not install.');
    return;
  }
  window.EFB_API.use(FF2FSEfbBridge);
})(msfssdk);
