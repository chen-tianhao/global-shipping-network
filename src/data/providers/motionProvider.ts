/**
 * Motion-provider seam.
 *
 * Static skeleton data (ports/routes/stats/disruptions) always comes from
 * `StaticDataProvider`. Motion can come from the synthetic placeholder or from
 * an exported trajectory; `bootstrap` selects one by id, so switching to real
 * data is a config change rather than a code change.
 */

import type { ProviderContext } from '../provider';
import type { TimeRange, VesselTrackSet } from '../types';
import { PlaceholderMotionProvider } from './placeholderMotionProvider';
import { RealTrajectoryProvider } from './realTrajectoryProvider';

export interface MotionProvider {
  readonly id: string;
  /** True only for synthetic motion; the UI keeps the honesty banner for it. */
  readonly isPlaceholder: boolean;
  init(ctx: ProviderContext): Promise<void>;
  getMotion(range: TimeRange): Promise<VesselTrackSet>;
}

export function isRealMotionId(id: string): boolean {
  const normalised = id.trim().toLowerCase();
  return normalised === 'real' || normalised === 'real-trajectory';
}

export function createMotionProvider(id: string): MotionProvider {
  if (isRealMotionId(id)) return new RealTrajectoryProvider();
  if (id !== 'placeholder' && id !== 'placeholder-motion') {
    console.warn(
      `[motion] unknown provider "${id}", falling back to placeholder`,
    );
  }
  return new PlaceholderMotionProvider();
}
