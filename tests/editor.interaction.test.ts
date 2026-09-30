import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/constants';
import { latLonToVec } from '../src/core/math3';
import type { Vec3, WorldPointerEvent } from '../src/core/types';
import { CRUST_CONTINENTAL } from '../src/core/types';
import { EditorCore } from '../src/editor/editorCore';
import type { InteractionHost, ToolSettings } from '../src/editor/interaction';
import { PointerInteraction } from '../src/editor/interaction';
import type { OpResult } from '../src/editor/opResult';
import { blankDraft } from '../src/tectonics/draft';
import { smallMesh } from './helpers/fixtures';

const mesh = smallMesh(12000);
const ll = (latDeg: number, lonDeg: number): Vec3 => latLonToVec(latDeg * DEG, lonDeg * DEG);

function setup(tool: ToolSettings['tool']) {
  const core = new EditorCore(mesh, blankDraft(mesh, 1));
  core.addPlate();
  const settings: ToolSettings = {
    tool, brushKm: 300, continentMode: 'land', raiseMode: 'raise', raiseAmount: 100, lassoTarget: 'new', seedRoughness: 0.5, style: 'plates',
  };
  const done: OpResult[] = [];
  const host: InteractionHost = {
    core,
    settings,
    seeds: [],
    view: () => null,
    selectedIndex: () => 1,
    select: () => {},
    seedsChanged: () => {},
    highlight: () => {},
    changed: () => {},
    opDone: (r) => done.push(r),
    motionDrag: () => {},
    setCursor: () => {},
    hover: () => {},
  };
  return { core, ia: new PointerInteraction(host), done };
}

const ev = (type: WorldPointerEvent['type'], at: [number, number] | null, buttons: number): WorldPointerEvent => ({
  type, point: at ? { lat: at[0] * DEG, lon: at[1] * DEG } : null, clientX: 0, clientY: 0, buttons, shiftKey: false, altKey: false, ctrlKey: false,
});

describe('PointerInteraction', () => {
  it('a stroke whose button was released outside the view ends instead of painting on hover', () => {
    const { core, ia, done } = setup('plate');
    ia.handle(ev('down', [0, 0], 1));
    ia.handle(ev('move', [0, 5], 1));
    expect(core.plateAt(ll(0, 5))).toBe(1);
    // Pointer left while painting and the button was released outside: the views report 'leave',
    // then only 'hover' events with no button pressed.
    ia.handle(ev('leave', null, 1));
    ia.handle(ev('hover', [40, 100], 0));
    ia.handle(ev('hover', [40, 120], 0));
    expect(ia.busy).toBe(false);
    expect(core.busy).toBe(false);
    expect(done.length).toBe(1);
    expect(done[0].ok).toBe(true);
    expect(core.plateAt(ll(40, 110))).toBe(0);
    expect(core.canUndo).toBe(true);
  });

  it('a stroke continues while the button stays down, and cancel reverts it', () => {
    const { core, ia } = setup('continent');
    ia.handle(ev('down', [10, 10], 1));
    ia.handle(ev('move', [10, 20], 1));
    expect(core.busy).toBe(true);
    expect(core.draft.crust.some((c) => c === CRUST_CONTINENTAL)).toBe(true);
    ia.cancel();
    expect(core.busy).toBe(false);
    expect(core.draft.crust.some((c) => c === CRUST_CONTINENTAL)).toBe(false);
  });
});
