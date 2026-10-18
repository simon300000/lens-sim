import { Body, Equator, Horizon, Observer, Illumination, MoonPhase, SearchRiseSet, SearchAltitude } from 'astronomy-engine';

/** Matsumoto, Nagano; fixed Japan Standard Time, degrees east/north, metres ASL. */
export const SITE = Object.freeze({ name: '日本 · 长野县松本', latitude: 36.238, longitude: 137.971, elevation: 660, utcOffset: 9 });
const DEG = Math.PI / 180, AU_KM = 149597870.7, HOUR = 3600000;
const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = a => { const n = Math.hypot(...a); return n > 1e-12 ? a.map(x => x / n) : [1, 0, 0]; };
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const eventCache = new Map();

/** Unit direction TO an object. World +X east, +Y up, -Z north; degrees. */
export function horizontalDirection(azimuth, altitude) {
  const a = azimuth * DEG, h = altitude * DEG;
  return [Math.sin(a) * Math.cos(h), Math.sin(h), -Math.cos(a) * Math.cos(h)];
}

/** Kasten–Young relative optical air mass; horizon clamped, no below-ground rays.
 * NOAA formula: https://gml.noaa.gov/grad/antuv/SolarCalc.jsp
 */
export function relativeAirMass(altitude) {
  const h = clamp(altitude, 0, 90);
  return 1 / (Math.sin(h * DEG) + .50572 * (h + 6.07995) ** -1.6364);
}

/** Clear-sky broadband Beer–Lambert approximation, optical depth 0.15 at sea level.
 * This is a plausible atmosphere, not site/weather-measured photometry. */
export function atmosphericTransmission(altitude, elevation = SITE.elevation) {
  return Math.exp(-.15 * Math.exp(-elevation / 8434.5) * relativeAirMass(altitude));
}

/** Fraction of circular apparent disk above an ideal, unobstructed flat horizon. */
function diskVisibility(altitude, angularRadius) {
  const x = clamp(altitude / angularRadius, -1, 1);
  return (Math.acos(-x) + x * Math.sqrt(Math.max(0, 1 - x * x))) / Math.PI;
}

function bodyState(body, instant, observer, radiusKm) {
  // Equator of date, observer parallax, and aberration. Horizon('normal') adds
  // standard refraction. No dependency on browser locale or host time zone.
  const eq = Equator(body, instant, observer, true, true);
  const geometric = Horizon(instant, observer, eq.ra, eq.dec);
  const apparent = Horizon(instant, observer, eq.ra, eq.dec, 'normal');
  const distanceKm = eq.dist * AU_KM;
  const angularRadius = Math.asin(radiusKm / distanceKm) / DEG;
  return {
    azimuth: apparent.azimuth, altitude: apparent.altitude,
    geometricAltitude: geometric.altitude,
    direction: horizontalDirection(apparent.azimuth, apparent.altitude),
    geometricDirection: horizontalDirection(geometric.azimuth, geometric.altitude),
    distanceKm, angularRadius,
    visibleFraction: diskVisibility(apparent.altitude, angularRadius),
  };
}

function dailyEvents(date, startMs, observer, utcOffset) {
  const key = [date, observer.latitude, observer.longitude, observer.height, utcOffset].join('|');
  if (eventCache.has(key)) return { ...eventCache.get(key) };
  const start = new Date(startMs);
  const localHour = event => event ? (event.date.getTime() - startMs) / HOUR : null;
  const events = {
    // Top limb, standard refraction, ideal horizon; terrain occlusion is renderer-owned.
    sunrise: localHour(SearchRiseSet(Body.Sun, observer, 1, start, 1)),
    sunset: localHour(SearchRiseSet(Body.Sun, observer, -1, start, 1)),
    moonrise: localHour(SearchRiseSet(Body.Moon, observer, 1, start, 1)),
    moonset: localHour(SearchRiseSet(Body.Moon, observer, -1, start, 1)),
    civilDawn: localHour(SearchAltitude(Body.Sun, observer, 1, start, 1, -6)),
    civilDusk: localHour(SearchAltitude(Body.Sun, observer, -1, start, 1, -6)),
  };
  if (eventCache.size >= 64) eventCache.delete(eventCache.keys().next().value);
  eventCache.set(key, events);
  return { ...events };
}

// Approximate Planckian-locus xy -> linear sRGB, normalized luminance.
// This is a chromatic approximation, not a spectral atmosphere solver.
function kelvinColor(kelvin) {
  const t = clamp(kelvin, 2000, 25000);
  const x = t <= 4000
    ? -.2661239e9 / t ** 3 - .2343580e6 / t ** 2 + .8776956e3 / t + .179910
    : -3.0258469e9 / t ** 3 + 2.1070379e6 / t ** 2 + .2226347e3 / t + .240390;
  const y = t <= 2222 ? -1.1063814 * x ** 3 - 1.34811020 * x ** 2 + 2.18555832 * x - .20219683
    : t <= 4000 ? -.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - .16748867
      : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - .37001483;
  const X = x / y, Z = (1 - x - y) / y;
  const rgb = [3.2406 * X - 1.5372 - .4986 * Z, -.9689 * X + 1.8758 + .0415 * Z, .0557 * X - .204 + 1.057 * Z].map(v => Math.max(0, v));
  const luminance = dot(rgb, [.2126, .7152, .0722]);
  return rgb.map(v => v / luminance);
}

function diffuseSolarLux(altitude) {
  // Clear-sky log-lux anchors, with smooth interpolation through civil/nautical/
  // astronomical twilight. No directional sunlight when the entire disk is down.
  const anchors = [[-18, -3.7], [-12, -2.3], [-6, .5], [0, 2.6], [6, 3.5], [15, 3.9], [45, 4.1], [90, 4.2]];
  if (altitude <= -18) return 10 ** -3.7;
  for (let i = 1; i < anchors.length; i++) {
    const [a, x] = anchors[i - 1], [b, y] = anchors[i];
    if (altitude <= b) return 10 ** (x + (y - x) * smooth(a, b, altitude));
  }
  return 10 ** 4.2;
}

/**
 * Pure celestial/time state (event searches are memoized). date is YYYY-MM-DD in
 * the site's FIXED offset, hour in [0,24]. 24 means next day's 00:00, never wraps
 * to the input day's start. Latitude/longitude degrees N/E; elevation metres ASL.
 *
 * sun/moon: topocentric azimuth clockwise from north, refracted altitude and
 * geometricAltitude degrees; direction TO body, distanceKm, angularRadius degrees.
 * moon.phaseAngle: Sun-Moon-Earth degrees (0 full); phaseLongitude: waxing cycle
 * 0 new /90 first quarter /180 full /270 last quarter. illuminatedFraction is
 * geocentric, and topocentricIlluminatedFraction includes observer parallax.
 * illuminationDirection points from Moon toward Sun in geometric world axes;
 * brightLimbDirection is its projection into Moon's tangent plane. This lets a
 * disk/sphere shader light the correct limb instead of forcing an opposite Sun.
 *
 * lighting: sunLux/moonLux DIRECT NORMAL lux (apply cosine for horizontal lux).
 * ambientLux is diffuse horizontal illuminance. RGB colors are LINEAR sRGB with
 * luminance 1 (channels may exceed 1), Kelvin values are appearance approximations.
 * exposure is photographic gain 1/(1.2*2^EV100), EV100 limited [0,16], metered with a
 * brightness-dependent key (bright daylight is exposed up to 1.3 EV brighter).
 * If a renderer divides all illuminance by S, multiply exposure by S as well.
 * sky RGB are illustrative LINEAR chromatic colors; brightness is renderer-owned.
 * events are hours on the returned localDate; null means no event that day.
 *
 * Ephemerides: Astronomy Engine (documented ~1 arcmin target), observer parallax,
 * aberration, standard refraction. Atmosphere/photometry/exposure are simplified
 * clear-sky models, not a claim of measured weather, spectral accuracy, eclipses,
 * terrain-horizon sunrise, or complete real-world global illumination.
 * Source: https://github.com/cosinekitty/astronomy/blob/master/source/js/README.md
 */
export function computeCelestialState({ hour, date = '2026-09-26', latitude = SITE.latitude, longitude = SITE.longitude, elevation = SITE.elevation, utcOffset = SITE.utcOffset } = {}) {
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) throw new RangeError('hour must be between 0 and 24');
  for (const [name, value, lo, hi] of [['latitude', latitude, -90, 90], ['longitude', longitude, -180, 180], ['elevation', elevation, -500, 10000], ['utcOffset', utcOffset, -14, 14]]) {
    if (!Number.isFinite(value) || value < lo || value > hi) throw new RangeError(`${name} must be between ${lo} and ${hi}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('date must be YYYY-MM-DD');
  const dateMs = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(dateMs) || new Date(dateMs).toISOString().slice(0, 10) !== date) throw new RangeError('date must be a valid calendar date');
  const instantMs = dateMs + (hour - utcOffset) * HOUR;
  const instant = new Date(instantMs);
  const localDate = new Date(dateMs + hour * HOUR).toISOString().slice(0, 10);
  const localHour = hour === 24 ? 0 : hour;
  const dayStartMs = instantMs - localHour * HOUR;
  const observer = new Observer(latitude, longitude, elevation);
  const sun = bodyState(Body.Sun, instant, observer, 695700);
  const moon = bodyState(Body.Moon, instant, observer, 1737.4);
  const illumination = Illumination(Body.Moon, instant);
  const phaseLongitude = MoonPhase(instant);
  const illuminationDirection = norm(sun.geometricDirection.map((v, i) => v * sun.distanceKm - moon.geometricDirection[i] * moon.distanceKm));
  const alongView = dot(illuminationDirection, moon.geometricDirection);
  const limb = illuminationDirection.map((v, i) => v - alongView * moon.geometricDirection[i]);
  // Exact opposition/conjunction has no unique bright-limb angle. Stable finite
  // fallback is perpendicular to viewing direction, unused for a full/new disk.
  const fallback = Math.abs(moon.geometricDirection[1]) < .99 ? [0, 1, 0] : [1, 0, 0];
  const brightLimbDirection = Math.hypot(...limb) > 1e-8 ? norm(limb) : norm(fallback.map((v, i) => v - dot(fallback, moon.geometricDirection) * moon.geometricDirection[i]));
  const phaseName = phaseLongitude < 2 || phaseLongitude > 358 ? '新月'
    : Math.abs(phaseLongitude - 180) < 6 ? '满月'
      : Math.abs(phaseLongitude - 90) < 2 ? '上弦月'
        : Math.abs(phaseLongitude - 270) < 2 ? '下弦月'
          : phaseLongitude < 90 ? '娥眉月' : phaseLongitude < 180 ? '盈凸月'
            : phaseLongitude < 270 ? '亏凸月' : '残月';
  Object.assign(moon, {
    illuminatedFraction: illumination.phase_fraction,
    topocentricIlluminatedFraction: clamp((1 - alongView) / 2),
    phaseAngle: illumination.phase_angle, phaseLongitude, waxing: phaseLongitude < 180,
    phaseName,
    illuminationDirection, brightLimbDirection,
  });
  const solarTransmission = atmosphericTransmission(sun.altitude, elevation);
  const lunarTransmission = atmosphericTransmission(moon.altitude, elevation);
  const sunLux = 127500 * (AU_KM / sun.distanceKm) ** 2 * solarTransmission * sun.visibleFraction;
  // Krisciunas & Schaefer phase falloff (no separate opposition-surge/eclipses):
  // https://articles.adsabs.harvard.edu/pdf/1991PASP..103.1033K
  // A quarter Moon has much less than half the full Moon's illuminance.
  const a = moon.phaseAngle;
  const lunarPhaseBrightness = 10 ** (-.4 * (.026 * a + 4e-9 * a ** 4));
  const moonLux = .32 * (384400 / moon.distanceKm) ** 2 * lunarPhaseBrightness * lunarTransmission * moon.visibleFraction;
  const sunHorizontalLux = sunLux * Math.max(0, Math.sin(sun.altitude * DEG));
  const moonHorizontalLux = moonLux * Math.max(0, Math.sin(moon.altitude * DEG));
  const ambientLux = diffuseSolarLux(sun.geometricAltitude) + .15 * moonHorizontalLux;
  const meteredLux = sunHorizontalLux + moonHorizontalLux + ambientLux;
  // Reflected-light metering would render every daylight hour as the same mid
  // grey. Photographs of bright scenes are printed brighter (a higher key), so
  // strong daylight keeps up to 1.3 EV of its extra brightness. Night is exposed
  // as a photograph of the lamp-lit house (EV 0), not as a moonlight long exposure.
  const key = 1.3 * smooth(4.2, 5.0, Math.log10(Math.max(1, meteredLux)));
  const ev100 = clamp(Math.log2(Math.max(.0001, meteredLux) / 2.5) - key, 0, 16);
  const daylight = smooth(-6, 8, sun.geometricAltitude);
  const night = 1 - smooth(-18, -6, sun.geometricAltitude);
  const twilight = smooth(-18, -5, sun.geometricAltitude) * (1 - smooth(0, 12, sun.geometricAltitude));
  const sunKelvin = 2000 + 3778 * (1 - Math.exp(-Math.max(0, sun.altitude) / 15));
  const moonKelvin = 2400 + 1700 * (1 - Math.exp(-Math.max(0, moon.altitude) / 12));
  const zenith = mix([.0025, .0045, .012], [.16, .35, .68], daylight);
  const horizon = mix(mix([.008, .012, .027], [.55, .22, .085], twilight), [.62, .76, .88], smooth(0, 20, sun.geometricAltitude));
  return {
    date, localDate, localHour, requestedHour: hour, utcISO: instant.toISOString(),
    site: { latitude, longitude, elevation, utcOffset }, sun, moon,
    events: dailyEvents(localDate, dayStartMs, observer, utcOffset),
    lighting: { sunLux, moonLux, sunHorizontalLux, moonHorizontalLux, ambientLux, meteredLux,
      solarTransmission, lunarTransmission, sunKelvin, moonKelvin,
      sunColor: kelvinColor(sunKelvin), moonColor: kelvinColor(moonKelvin),
      ev100, exposure: 1 / (1.2 * 2 ** ev100), daylight, night, twilight },
    sky: { zenith, horizon, twilight: [.9, .24, .07],
      starVisibility: night / (1 + 20 * moonHorizontalLux),
      moonVisibility: moon.visibleFraction / (1 + ambientLux / 2000) },
  };
}
