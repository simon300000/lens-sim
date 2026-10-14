import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { computeCelestialState, horizontalDirection, relativeAirMass, atmosphericTransmission, SITE } from '../src/astronomy.js';

const near = (actual, expected, tolerance, label = '') => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} expected ${expected} ± ${tolerance}`);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

test('independent NREL SPA published solar position fixture', () => {
  // Reda & Andreas, NREL/TP-560-34302, Appendix A validation example.
  // https://www.nrel.gov/docs/fy08osti/34302.pdf
  // 2003-10-17 12:30:30 MST, 39.742476 N, 105.1786 W, 1830.14m.
  // SPA refraction uses 820mbar/11C; our standard refraction differs slightly.
  // Thus 0.04 deg altitude tolerance rather than pretending identical weather.
  const { sun } = computeCelestialState({ hour: 12 + 30 / 60 + 30 / 3600, date: '2003-10-17', latitude: 39.742476, longitude: -105.1786, elevation: 1830.14, utcOffset: -7 });
  near(sun.azimuth, 194.34024, .02, 'azimuth');
  near(sun.altitude, 90 - 50.11162, .04, 'apparent altitude');
});

test('independent USNO Sun/Moon rise-set and twilight fixtures', () => {
  // USNO output retrieved 2026-10-13; fixture has minute precision.
  // https://aa.usno.navy.mil/calculated/rstt/oneday?date=2026-09-26&dst=false&label=&lat=0.0000&lon=0.0000&submit=Get+Data&tz=0.00&tz_label=false&tz_sign=-1
  const { events } = computeCelestialState({ hour: 12, date: '2026-09-26', latitude: 0, longitude: 0, elevation: 0, utcOffset: 0 });
  const fixture = { sunrise: 5 + 48 / 60, sunset: 17 + 55 / 60, civilDawn: 5 + 27 / 60, civilDusk: 18 + 15 / 60, moonrise: 17 + 49 / 60, moonset: 5 + 25 / 60 };
  for (const [key, expected] of Object.entries(fixture)) near(events[key], expected, 1.1 / 60, key);
});

test('independent USNO primary phases, real waxing/waning and lunar brightness', () => {
  // https://aa.usno.navy.mil/calculated/moon/phases?date=2026-09-01&nump=8
  // Full 2026-09-26 16:49 UTC; new 2026-09-11 03:27 UTC;
  // first quarter 2026-09-18 20:44 UTC; last quarter Oct3 13:25 UTC.
  const full = computeCelestialState({ date: '2026-09-26', hour: 16 + 49 / 60, utcOffset: 0 });
  const fresh = computeCelestialState({ date: '2026-09-11', hour: 3 + 27 / 60, utcOffset: 0 });
  const first = computeCelestialState({ date: '2026-09-18', hour: 20 + 44 / 60, utcOffset: 0 });
  const last = computeCelestialState({ date: '2026-10-03', hour: 13 + 25 / 60, utcOffset: 0 });
  near(full.moon.phaseLongitude, 180, .05);
  near(Math.min(fresh.moon.phaseLongitude, 360 - fresh.moon.phaseLongitude), 0, .05);
  near(first.moon.phaseLongitude, 90, .05);
  near(last.moon.phaseLongitude, 270, .05);
  assert.ok(full.moon.illuminatedFraction > .998);
  assert.ok(fresh.moon.illuminatedFraction < .003);
  assert.equal(first.moon.waxing, true);
  assert.equal(last.moon.waxing, false);
  assert.ok(first.moon.illuminatedFraction > .48 && first.moon.illuminatedFraction < .52);
  assert.ok(Math.abs(dot(first.sun.geometricDirection, first.moon.geometricDirection)) < .1, 'quarter Moon is not forced opposite Sun');
});

test('world coordinates east/up/north and actual Matsumoto day direction', () => {
  const fixtures = [[0, 0, [0, 0, -1]], [90, 0, [1, 0, 0]], [180, 0, [0, 0, 1]], [270, 0, [-1, 0, 0]], [0, 90, [0, 1, 0]]];
  for (const [az, alt, vector] of fixtures) horizontalDirection(az, alt).forEach((x, i) => near(x, vector[i], 1e-12));
  const { events } = computeCelestialState({ hour: 12 });
  assert.ok(computeCelestialState({ hour: events.sunrise }).sun.direction[0] > .9);
  assert.ok(computeCelestialState({ hour: events.sunset }).sun.direction[0] < -.9);
  const noon = computeCelestialState({ hour: 12 });
  assert.ok(noon.sun.direction[1] > .7 && noon.sun.direction[2] > .5, 'noon Sun high toward south');
  near(SITE.utcOffset, 9, 0);
});

test('24:00 is next-day midnight; endpoint time and lighting are exactly continuous', () => {
  const end = computeCelestialState({ hour: 24, date: '2026-09-26' });
  const next = computeCelestialState({ hour: 0, date: '2026-09-27' });
  assert.equal(end.utcISO, '2026-09-26T15:00:00.000Z');
  assert.equal(end.localDate, '2026-09-27');
  assert.equal(end.localHour, 0);
  for (const key of ['sun', 'moon', 'lighting', 'sky', 'events']) assert.deepEqual(end[key], next[key]);
  const before = computeCelestialState({ hour: 24 - 1 / 3600 });
  near(before.sun.altitude, end.sun.altitude, .01);
  near(before.moon.altitude, end.moon.altitude, .01);
  assert.notDeepEqual(end.moon.direction, computeCelestialState({ hour: 0 }).moon.direction);
});

test('host timezone cannot alter site times or celestial results', () => {
  const source = "import{computeCelestialState as c}from'./src/astronomy.js';console.log(JSON.stringify(c({hour:6.25})))";
  const run = TZ => execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('..', import.meta.url), env: { ...process.env, TZ }, encoding: 'utf8' });
  assert.equal(run('America/Los_Angeles'), run('Asia/Tokyo'));
});

test('atmospheric path extinction is monotonic and elevation reduces attenuation', () => {
  const heights = [0, 1, 5, 15, 30, 60, 90];
  for (let i = 1; i < heights.length; i++) {
    assert.ok(relativeAirMass(heights[i]) < relativeAirMass(heights[i - 1]));
    assert.ok(atmosphericTransmission(heights[i]) > atmosphericTransmission(heights[i - 1]));
  }
  near(relativeAirMass(90), 1, .001);
  assert.ok(atmosphericTransmission(30, 2000) > atmosphericTransmission(30, 0));
  assert.ok(relativeAirMass(-90) > 30 && Number.isFinite(relativeAirMass(-90)));
});

test('full-day sweep: finite, bounded, correct disk phase basis and no subterranean direct light', () => {
  const finite = (value, path = '') => {
    if (typeof value === 'number') assert.ok(Number.isFinite(value), path);
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) finite(v, `${path}.${k}`);
  };
  for (let minute = 0; minute <= 1440; minute += 5) {
    const state = computeCelestialState({ hour: minute / 60 });
    finite(state);
    for (const name of ['sun', 'moon']) {
      const body = state[name];
      near(Math.hypot(...body.direction), 1, 1e-12);
      assert.ok(body.azimuth >= 0 && body.azimuth < 360);
      assert.ok(body.visibleFraction >= 0 && body.visibleFraction <= 1);
      if (body.altitude + body.angularRadius <= 0) assert.equal(state.lighting[`${name}Lux`], 0);
    }
    near(Math.hypot(...state.moon.illuminationDirection), 1, 1e-12);
    near(dot(state.moon.brightLimbDirection, state.moon.geometricDirection), 0, 1e-10);
    assert.ok(state.moon.angularRadius > .23 && state.moon.angularRadius < .3);
    assert.ok(state.lighting.ev100 >= -2 && state.lighting.ev100 <= 16);
    assert.ok(state.lighting.moonLux >= 0 && state.lighting.moonLux < .5);
  }
  const noon = computeCelestialState({ hour: 12 }).lighting;
  assert.ok(noon.sunLux > 80000 && noon.sunLux < 130000);
  assert.ok(computeCelestialState({ hour: 0 }).lighting.meteredLux < .5);
});

test('dawn and sunset remain continuous through first/last visible disk and centre horizon', () => {
  const { events } = computeCelestialState({ hour: 12 });
  // Dense 0.1s steps in ten-minute windows around BOTH apparent rise/set,
  // including the disk centre crossing zero; catches a hard on/off switch.
  for (const centre of [events.sunrise, events.sunset]) {
    let previous;
    for (let step = -3000; step <= 3000; step++) {
      const state = computeCelestialState({ hour: centre + step / 36000 });
      if (previous) {
        near(state.lighting.sunLux, previous.lighting.sunLux, 3, '0.1s direct-light delta');
        near(state.lighting.ambientLux, previous.lighting.ambientLux, 1, '0.1s ambient delta');
        near(state.lighting.exposure, previous.lighting.exposure, .001, '0.1s exposure delta');
      }
      previous = state;
    }
  }
});

test('polar day/night and invalid input are explicit', () => {
  const summer = computeCelestialState({ date: '2026-06-21', hour: 12, latitude: 89 });
  const winter = computeCelestialState({ date: '2026-12-21', hour: 12, latitude: 89 });
  assert.equal(summer.events.sunrise, null);
  assert.equal(summer.events.sunset, null);
  assert.equal(winter.events.sunrise, null);
  assert.equal(winter.events.sunset, null);
  assert.ok(summer.lighting.sunLux > 0);
  assert.equal(winter.lighting.sunLux, 0);
  for (const input of [{ hour: -1 }, { hour: 25 }, { hour: NaN }, { hour: 3, date: '2026-02-30' }, { hour: 3, date: '09/26/2026' }, { hour: 3, latitude: 91 }]) assert.throws(() => computeCelestialState(input), RangeError);
});
