/**
 * Time controls: play/pause, speed and a simulation-day scrubber.
 *
 * Cesium's own timeline widget stays visible and draggable; this strip adds the
 * simulation-specific read-out (day number, simulated date) and speed presets.
 */

import { el } from './dom';
import { formatSimDate, formatSimDay } from '../cesium/clock';
import type { SimDay } from '../data/types';

export interface TimeBarOptions {
  startDay: SimDay;
  endDay: SimDay;
  multiplier: number;
  playing: boolean;
  onPlayChange(playing: boolean): void;
  onMultiplierChange(multiplier: number): void;
  /** Called while the user drags the scrubber. */
  onScrub(day: SimDay): void;
  /** Jump to the next disruption start (wraps to the earliest). */
  onNextDisruption(): void;
}

export interface TimeBar {
  /** Called from the render loop; ignores sub-0.1-day changes. */
  sync(day: SimDay): void;
  setPlaying(playing: boolean): void;
  /** Expand or collapse the visible range when the warm-up toggle changes. */
  setRange(startDay: SimDay, endDay: SimDay): void;
}

/** Sim-hours of simulated time per wall-clock second. */
const SPEEDS: Array<{ label: string; hours: number }> = [
  { label: '1 时/秒', hours: 1 },
  { label: '6 时/秒', hours: 6 },
  { label: '1 天/秒', hours: 24 },
  { label: '3 天/秒', hours: 72 },
];

export function createTimeBar(root: HTMLElement, options: TimeBarOptions): TimeBar {
  let rangeStart = options.startDay;
  let rangeEnd = options.endDay;

  const bar = el('div', 'timebar');

  const playButton = el('button', 'timebar__button', options.playing ? '暂停' : '播放');
  let playing = options.playing;
  playButton.addEventListener('click', () => {
    playing = !playing;
    playButton.textContent = playing ? '暂停' : '播放';
    options.onPlayChange(playing);
  });

  const nextDisruption = el('button', 'timebar__button', '下一扰动');
  nextDisruption.addEventListener('click', () => options.onNextDisruption());

  const speedSelect = el('select', 'timebar__select');
  for (const speed of SPEEDS) {
    const option = el('option');
    option.value = String(speed.hours * 3600);
    option.textContent = speed.label;
    speedSelect.append(option);
  }
  speedSelect.value = String(options.multiplier);
  speedSelect.addEventListener('change', () => {
    options.onMultiplierChange(Number(speedSelect.value));
  });

  const slider = el('input', 'timebar__slider');
  slider.type = 'range';
  slider.min = String(rangeStart);
  slider.max = String(rangeEnd);
  slider.step = '0.1';
  slider.value = String(rangeStart);
  let scrubbing = false;
  slider.addEventListener('input', () => {
    scrubbing = true;
    renderReadout(Number(slider.value));
    options.onScrub(Number(slider.value));
  });
  slider.addEventListener('change', () => {
    scrubbing = false;
  });

  const readout = el('span', 'timebar__readout');
  renderReadout(rangeStart);

  bar.append(playButton, nextDisruption, speedSelect, slider, readout);
  root.append(bar);

  function renderReadout(day: SimDay): void {
    readout.textContent = `${formatSimDay(day)} · ${formatSimDate(day)} / 至 Day ${Math.round(
      rangeEnd,
    )}`;
  }

  let lastRendered = Number.NaN;
  return {
    sync(day: SimDay): void {
      if (scrubbing) return;
      if (Math.abs(day - lastRendered) < 0.1) return;
      lastRendered = day;
      slider.value = String(day);
      renderReadout(day);
    },
    setPlaying(next: boolean): void {
      playing = next;
      playButton.textContent = playing ? '暂停' : '播放';
    },
    setRange(startDay: SimDay, endDay: SimDay): void {
      rangeStart = startDay;
      rangeEnd = endDay;
      slider.min = String(rangeStart);
      slider.max = String(rangeEnd);
      slider.value = String(rangeStart);
      lastRendered = rangeStart;
      renderReadout(rangeStart);
    },
  };
}
