/** What UI components can ask the application to do (implemented by the controller). */
import type { Action, AppState } from './state';
import type { Store } from './store';

export interface Commands {
  generate(): void;
  /** New random seed and generate. */
  randomizeSeed(): void;
  togglePlay(): void;
  step(): void;
  /** Show a history keyframe (null = back to the live state). */
  showKeyframe(index: number | null): void;
  /** Branch the simulation from the keyframe on screen. */
  playFromKeyframe(): void;
  computeClimate(): void;
  toggleSeasons(): void;
  exportMap(): void;
  exportScreenshot(): void;
}

export interface UiContext {
  store: Store<AppState, Action>;
  commands: Commands;
}
