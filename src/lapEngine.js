// Pure lap state machine. No IO — takes state + fix + event config, returns new state + events.
//
// An event has an ordered list of zones (polygons). Zone 0 is start/finish.
// A lap is credited on the sequence: enter zone 0 (arms the lap) -> enter zone 1
// -> ... -> enter zone n-1 -> enter zone 0 again.
//
// Lap TIMING runs from EXITING zone 0 to re-ENTERING it, so time spent
// standing in the start box (handoffs, waiting for the gun, mid-stint pauses
// at base) never counts against the lap. The measured segment is therefore
// (lap length - start-box crossing): calibrate minLapS/maxLapS to that
// distance, e.g. ~350m of a 400m track at the 7:00/km ceiling ≈ 147s.
// Out-of-window laps re-arm but do not score.
//
// Two ALTERNATIVE timings ride along on every lap for on-track comparison
// (they never affect credit):
// - entrySeconds: zone-0 entry to zone-0 entry (true full lap, but standing
//   in the box counts against it)
// - gate crossings: if config.gate = [[lat,lng],[lat,lng]] is set (a line
//   across the track inside the start box), each fix-to-fix segment is
//   tested for crossing and the moment is interpolated between the two fix
//   timestamps — sub-fix-interval precision over the true full lap. A gate
//   lap is only emitted when the zone sequence completed since the previous
//   crossing; every crossing (jitter included) resets the gate clock, which
//   makes standing on the line harmless.

export function createState() {
  return {
    armed: false,        // has the runner entered zone 0 at least once
    nextZone: 0,         // next zone index that must be entered
    lapStartedAt: null,  // ms epoch of the last zone-0 EXIT (lap clock start)
    inZone: null,        // zone index the runner is officially inside, or null
    candZone: null,      // zone being dwell-counted for entry
    candStreak: 0,
    exitStreak: 0,
    lapCount: 0,
    lastLapS: null,
    entryClockAt: null,  // ms epoch of last zone-0 ENTRY (entry-to-entry comparison)
    prevFix: null,       // {lat, lng, t} of the previous accepted fix (gate detection)
    gateClockAt: null,   // ms epoch of last gate crossing
    gateEligible: false, // zone sequence completed since the last crossing
  };
}

// Do segments a1->a2 and b1->b2 intersect? Returns the parameter along a1->a2
// (0..1) or null. Planar approximation — fine at track scale.
export function segmentIntersection(a1, a2, b1, b2) {
  const d1 = [a2[0] - a1[0], a2[1] - a1[1]];
  const d2 = [b2[0] - b1[0], b2[1] - b1[1]];
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  if (denom === 0) return null; // parallel
  const dx = [b1[0] - a1[0], b1[1] - a1[1]];
  const t = (dx[0] * d2[1] - dx[1] * d2[0]) / denom;
  const u = (dx[0] * d1[1] - dx[1] * d1[0]) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// Ray-casting point-in-polygon. polygon: [[lat, lng], ...]
export function pointInPolygon(lat, lng, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [latI, lngI] = polygon[i];
    const [latJ, lngJ] = polygon[j];
    const intersects =
      (latI > lat) !== (latJ > lat) &&
      lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (intersects) inside = !inside;
  }
  return inside;
}

function zoneAt(lat, lng, zones) {
  for (let i = 0; i < zones.length; i++) {
    if (pointInPolygon(lat, lng, zones[i].polygon)) return i;
  }
  return null;
}

/**
 * @param {object} state    from createState() or a previous call
 * @param {object} fix      { lat, lng, timestampMs, accuracyM }
 * @param {object} config   { zones, minLapS, maxLapS, entryFixes, exitFixes, maxAccuracyM }
 * @returns {{ state, events: Array<{type, ...}> }}
 */
export function processFix(state, fix, config) {
  const s = { ...state };
  const events = [];
  const entryFixes = config.entryFixes ?? 1;
  const exitFixes = config.exitFixes ?? 2;

  if (fix.accuracyM != null && fix.accuracyM > (config.maxAccuracyM ?? 40)) {
    return { state: s, events: [{ type: 'dropped', reason: 'accuracy' }] };
  }

  // Gate crossing (comparison timing) — checked on the raw track between
  // consecutive accepted fixes, independent of zone dwell.
  if (config.gate && s.prevFix) {
    const p = segmentIntersection(
      [s.prevFix.lat, s.prevFix.lng], [fix.lat, fix.lng],
      config.gate[0], config.gate[1]
    );
    if (p !== null) {
      const crossedAt = s.prevFix.t + p * (fix.timestampMs - s.prevFix.t);
      if (s.gateEligible && s.gateClockAt != null) {
        events.push({ type: 'gate_lap', seconds: (crossedAt - s.gateClockAt) / 1000 });
        s.gateEligible = false;
      }
      s.gateClockAt = crossedAt; // every crossing (jitter included) resets the clock
    }
  }
  s.prevFix = { lat: fix.lat, lng: fix.lng, t: fix.timestampMs };

  const zone = zoneAt(fix.lat, fix.lng, config.zones);

  let entered = null;
  if (s.inZone === null) {
    if (zone !== null) {
      if (s.candZone === zone) s.candStreak += 1;
      else { s.candZone = zone; s.candStreak = 1; }
      if (s.candStreak >= entryFixes) {
        s.inZone = zone;
        s.candZone = null;
        s.candStreak = 0;
        s.exitStreak = 0;
        entered = zone;
      }
    } else {
      s.candZone = null;
      s.candStreak = 0;
    }
  } else if (zone === s.inZone) {
    s.exitStreak = 0;
  } else {
    s.exitStreak += 1;
    if (s.exitStreak >= exitFixes) {
      const leftZone = s.inZone;
      s.inZone = null;
      s.exitStreak = 0;
      // The lap clock starts when the runner leaves the start box — so
      // standing at the line (handoff, gun, mid-stint pause) never counts.
      if (leftZone === 0 && s.armed) s.lapStartedAt = fix.timestampMs;
      if (zone !== null) {
        // this fix immediately starts dwell for the new zone
        s.candZone = zone;
        s.candStreak = 1;
        if (s.candStreak >= entryFixes) {
          s.inZone = zone;
          s.candZone = null;
          s.candStreak = 0;
          entered = zone;
        }
      }
    }
  }

  if (entered !== null) {
    events.push({ type: 'zone_enter', zone: entered });

    if (entered === 0) {
      if (s.armed && s.nextZone === 0 && s.lapStartedAt != null) {
        const seconds = (fix.timestampMs - s.lapStartedAt) / 1000;
        const counted = seconds >= config.minLapS && seconds <= config.maxLapS;
        if (counted) {
          s.lapCount += 1;
          s.lastLapS = seconds;
        }
        events.push({
          type: 'lap',
          seconds,
          counted,
          reason: counted ? null : seconds < config.minLapS ? 'too_fast' : 'too_slow',
          // comparison timing: true full lap, entry to entry
          entrySeconds: s.entryClockAt != null ? (fix.timestampMs - s.entryClockAt) / 1000 : null,
        });
      }
      // Any zone-0 entry (re-)arms the next lap, including a wrong-way or
      // aborted one. The lap clock starts on the way OUT of the box.
      s.armed = true;
      s.lapStartedAt = null;
      s.entryClockAt = fix.timestampMs;
      s.nextZone = config.zones.length > 1 ? 1 : 0;
    } else if (s.armed && entered === s.nextZone) {
      s.nextZone = (entered + 1) % config.zones.length;
      if (s.nextZone === 0) s.gateEligible = true; // sequence complete: next gate crossing may score
    }
    // Out-of-order checkpoint entries are ignored: the sequence stays strict.
  }

  return { state: s, events };
}
