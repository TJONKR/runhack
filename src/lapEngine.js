// Pure lap state machine. No IO — takes state + fix + event config, returns new state + events.
//
// An event has an ordered list of zones (polygons). Zone 0 is start/finish.
// A lap is credited on the sequence: enter zone 0 (arms the lap) -> enter zone 1
// -> ... -> enter zone n-1 -> enter zone 0 again, with the elapsed time inside
// [minLapS, maxLapS]. Out-of-window laps re-arm but do not score.

export function createState() {
  return {
    armed: false,        // has the runner entered zone 0 at least once
    nextZone: 0,         // next zone index that must be entered
    lapStartedAt: null,  // ms epoch of last zone-0 entry
    inZone: null,        // zone index the runner is officially inside, or null
    candZone: null,      // zone being dwell-counted for entry
    candStreak: 0,
    exitStreak: 0,
    lapCount: 0,
    lastLapS: null,
  };
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
      s.inZone = null;
      s.exitStreak = 0;
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
      if (s.armed && s.nextZone === 0) {
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
        });
      }
      // Any zone-0 entry (re-)arms the next lap, including a wrong-way or aborted one.
      s.armed = true;
      s.lapStartedAt = fix.timestampMs;
      s.nextZone = config.zones.length > 1 ? 1 : 0;
    } else if (s.armed && entered === s.nextZone) {
      s.nextZone = (entered + 1) % config.zones.length;
    }
    // Out-of-order checkpoint entries are ignored: the sequence stays strict.
  }

  return { state: s, events };
}
