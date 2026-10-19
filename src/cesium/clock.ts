/**
 * Simulation-day <-> Cesium JulianDate conversion, in exactly one place.
 *
 * Simulation day 0 is anchored to a modern calendar date purely so the
 * timeline widget reads naturally; the simulation itself starts at year 1.
 */

import { JulianDate } from 'cesium';
import type { SimDay } from '../data/types';

export const SIM_EPOCH_ISO = '2026-01-01T00:00:00Z';
const SIM_EPOCH = JulianDate.fromIso8601(SIM_EPOCH_ISO);
const SECONDS_PER_DAY = 86400;

export function dayToJulian(day: SimDay): JulianDate {
  return JulianDate.addSeconds(SIM_EPOCH, day * SECONDS_PER_DAY, new JulianDate());
}

export function julianToDay(date: JulianDate): SimDay {
  return JulianDate.secondsDifference(date, SIM_EPOCH) / SECONDS_PER_DAY;
}

/** Human label for a simulation day, e.g. "Day 137". */
export function formatSimDay(day: SimDay): string {
  return `Day ${Math.floor(day)}`;
}

/** Wall-clock label anchored to the epoch, e.g. "05-18". */
export function formatSimDate(day: SimDay): string {
  const date = JulianDate.toDate(dayToJulian(day));
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const dayOfMonth = `${date.getUTCDate()}`.padStart(2, '0');
  return `${month}-${dayOfMonth}`;
}
